import { scrapeKongreAra, mapKongreAraEvent } from './sources/kongreara.js';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import pLimit from 'p-limit';
import ws from 'ws';

// ── Clients ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { global: { WebSocket: ws } }
);

const resend = new Resend(process.env.RESEND_API_KEY);
const limit = pLimit(1);

// ── AI CALL ─────────────────────────────────────────────
async function callAI(prompt) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 1000,
      }),
    });

    const data = await response.json();

    if (data.error?.message?.includes('Rate limit')) {
      console.log('⏳ Rate limit → 15sn bekleniyor...');
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    if (data.error) throw new Error(data.error.message);

    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  throw new Error('AI failed after retries');
}

// ── SAFE JSON ────────────────────────────────────────────
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fixed = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .replace(/[\u0000-\u001F]+/g, ' ')
      .trim();
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

// ── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log('🚀 Scraper started...');

  const { data: log } = await supabase
    .from('scrape_logs')
    .insert({ status: 'running', triggered_by: 'github_actions' })
    .select()
    .single();

  const logId = log.id;

  const stats = {
    sources_scraped: 0,
    events_found: 0,
    events_added: 0,
    events_updated: 0,
    events_duplicate: 0,
  };

  try {
    await supabase.rpc('reset_is_new_flags');

    const { data: sources } = await supabase
      .from('sources')
      .select('*')
      .eq('is_active', true);

    console.log(`📋 ${sources.length} kaynak bulundu`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // AI tabanlı kaynaklar + AI'sız kongreara.com paralel taranıyor
    await Promise.all([
      ...sources.map(source => limit(() => scrapeSource(browser, source, stats))),
      scrapeKongreAraSource(browser, stats),
    ]);

    await browser.close();
    await sendNotifications(stats);

    await supabase
      .from('scrape_logs')
      .update({ ...stats, status: 'completed', finished_at: new Date().toISOString() })
      .eq('id', logId);

    console.log('✅ DONE:', stats);

  } catch (err) {
    console.error('❌ ERROR:', err);
    await supabase
      .from('scrape_logs')
      .update({ status: 'failed', error_message: err.message, finished_at: new Date().toISOString() })
      .eq('id', logId);
    process.exit(1);
  }
}

// ── KONGREARA.COM SCRAPER (AI'sız, doğrudan JSON parse) ──
async function scrapeKongreAraSource(browser, stats) {
  console.log(`\n🔍 kongreara.com (özel parser, AI'sız)`);

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
  });

  try {
    const rawEvents = await scrapeKongreAra(context);

    stats.sources_scraped++;
    stats.events_found += rawEvents.length;

    const today = new Date().toISOString().split('T')[0];

    for (const raw of rawEvents) {
      // Geçmiş tarihli etkinlikleri atla
      if (!raw.startDate || raw.startDate.split('T')[0] < today) {
        continue;
      }

      const eventData = mapKongreAraEvent(raw, null);

      // Duplicate kontrolü
      const { data: existing } = await supabase
        .from('events')
        .select('id')
        .eq('source_url', eventData.source_url)
        .maybeSingle();

      if (existing) {
        stats.events_duplicate++;
        continue;
      }

      const { error } = await supabase.from('events').insert(eventData);

      if (error) {
        console.warn(`  ⚠️ Insert hatası: ${error.message}`);
      } else {
        stats.events_added++;
        console.log(`  ✅ Eklendi: ${eventData.title}`);
      }
    }

  } catch (err) {
    console.error(`  ❌ kongreara.com genel hata: ${err.message}`);
  } finally {
    await context.close();
  }
}

// ── SOURCE SCRAPER (AI tabanlı, normal kaynaklar) ────────
async function scrapeSource(browser, source, stats) {
  console.log(`\n🔍 ${source.name} (${source.url})`);

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
  });

  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();

  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const links = (await extractEventLinks(page, source.url)).slice(0, 15);
    console.log(`  📎 ${links.length} link bulundu`);

    stats.sources_scraped++;
    stats.events_found += links.length;

    // Sayfaları tara, ham veri topla
    const batch = [];

    for (const link of links) {
      try {
        const raw = await scrapePageRaw(context, link);
        if (raw) batch.push(raw);

        // Her 3'te bir AI'a gönder
        if (batch.length === 3) {
          await processAIBatch(batch.splice(0, 3), source, stats);
          await delay(2000, 3000);
        }
      } catch (e) {
        console.warn(`  skip: ${link} — ${e.message}`);
      }
    }

    // Kalan varsa gönder
    if (batch.length > 0) {
      await processAIBatch(batch, source, stats);
    }

    await supabase
      .from('sources')
      .update({ last_scraped_at: new Date().toISOString(), scrape_count: source.scrape_count + 1 })
      .eq('id', source.id);

  } catch (err) {
    console.error(`  ❌ Kaynak hatası: ${err.message}`);
  } finally {
    await context.close();
  }
}

// ── RAW PAGE SCRAPE ──────────────────────────────────────
async function scrapePageRaw(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    const title = await page.title();

    const cleanHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);

    return { url, title, html: cleanHtml };
  } finally {
    await page.close();
  }
}

// ── FORMAT NORMALİZASYONU ─────────────────────────────────
// AI bazen "online and in-person" gibi şemada olmayan değerler döndürüyor.
// Supabase constraint'i sadece online/fiziksel/hibrit kabul ediyor.
function normalizeFormat(format) {
  if (!format) return null;
  const f = String(format).toLowerCase();

  if (f.includes('online') && (f.includes('in-person') || f.includes('hybrid') || f.includes('hibrit') || f.includes('physical') || f.includes('fiziksel'))) {
    return 'hybrid';
  }
  if (f.includes('hibrit') || f.includes('hybrid')) return 'hybrid';
  if (f.includes('online')) return 'online';
  if (f.includes('fiziksel') || f.includes('physical') || f.includes('in-person')) return 'physical';

  return null;
}

// ── AI BATCH PROCESS (3'lü) ──────────────────────────────
async function processAIBatch(events, source, stats) {
  const prompt = `Extract event information from these ${events.length} pages.
Return ONLY a JSON array, no other text, no markdown.
ONLY extract academic/professional events: conferences, congresses, symposiums, fairs, exhibitions.
DO NOT extract: general assembly meetings, board meetings, advisory council meetings, solidarity days, internal organizational events.
Only include events starting in 2026 or later.
FIELDS TO EXTRACT (use null if unknown):
- title: event name
- category: must be exactly one of "fuar", "kongre", "konferans", "sempozyum" (Turkish), or "workshop", "seminer" if applicable
- city: city name where event takes place
- country: country name
- format: must be exactly one of "online", "fiziksel", "hibrit"
- website: the event's own official website (NOT the listing page where you found it — try to find the actual event homepage if mentioned in the content)
- start_date: YYYY-MM-DD
- end_date: YYYY-MM-DD
- abstract_deadline: YYYY-MM-DD
- confidence: 0.0 to 1.0
PAGES:
${events.map((e, i) => `
[${i}]
url: ${e.url}
title: ${e.title}
content: ${e.html}
`).join('\n---\n')}
Return format: [{"title":"...","category":"...","city":"...","country":"...","format":"...","website":"...","start_date":"...","end_date":"...","abstract_deadline":"...","confidence":0.8}, ...]`;
  try {
    const text = await callAI(prompt);
    console.log('\n--- AI RESPONSE ---');
    console.log(text);
    console.log('-------------------\n');
    const json = safeJson(text);
    if (!Array.isArray(json)) {
      console.warn('  ⚠️ AI dizi döndürmedi');
      return;
    }
    const today = new Date().toISOString().split('T')[0];
    const excludeKeywords = [
      'genel kurul', 'yönetim kurulu', 'danışma kurulu',
      'dayanışma günü', 'mücadele günü', 'kurultay',
      'toplantısı', 'paneli',
    ];
    for (let i = 0; i < json.length; i++) {
      const item = json[i];
      if (!item?.title) continue;
      // ── FİLTRE 1: Geçmiş tarihli veya tarihsiz etkinlikleri atla ──
      if (!item.start_date || item.start_date < today) {
        continue;
      }
      // ── FİLTRE 2: İstenmeyen etkinlik türlerini atla ──
      const titleLower = item.title.toLowerCase();
      if (excludeKeywords.some(kw => titleLower.includes(kw))) {
        continue;
      }
      const sourceUrl = events[i]?.url || item.website;
      // ── Duplicate kontrolü ──
      const { data: existing } = await supabase
        .from('events')
        .select('id')
        .eq('source_url', sourceUrl)
        .maybeSingle();
      if (existing) {
        stats.events_duplicate++;
        continue;
      }
      const { error } = await supabase.from('events').insert({
        title: item.title,
        category: item.category || null,
        city: item.city || null,
        country: item.country || null,
        format: normalizeFormat(item.format),
        website: item.website || sourceUrl,
        start_date: item.start_date || null,
        end_date: item.end_date || null,
        abstract_deadline: item.abstract_deadline || null,
        ai_confidence_score: item.confidence || 0.5,
        source_id: source.id,
        source_url: sourceUrl,
        is_new: true,
        is_active: true,
        ai_extracted_at: new Date().toISOString(),
        ai_model: 'llama-3.1-8b-instant',
      });
      if (error) {
        console.warn(`  ⚠️ Insert hatası: ${error.message}`);
      } else {
        stats.events_added++;
        console.log(`  ✅ Eklendi: ${item.title}`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠️ AI batch hatası: ${err.message}`);
  }
}

// ── LINK EXTRACTOR ───────────────────────────────────────
async function extractEventLinks(page, baseUrl) {
  const links = await page.evaluate((base) => {
    return [...new Set(
      [...document.querySelectorAll('a[href]')]
        .map(a => { try { return new URL(a.href, base).href; } catch { return null; } })
        .filter(Boolean)
    )];
  }, baseUrl);

  const eventPatterns = [
    /\/etkinlik/i, /\/event/i, /\/conference/i, /\/congress/i,
    /\/symposium/i, /\/seminar/i, /\/workshop/i, /\/fair/i,
    /\/expo/i, /cfp/i, /\/kongre/i, /\/sempozyum/i,
  ];

  return links.filter(url =>
    eventPatterns.some(p => p.test(url)) &&
    url.startsWith('http') &&
    !url.includes('#') &&
    url !== baseUrl
  );
}

// ── NOTIFICATIONS ────────────────────────────────────────
async function sendNotifications(stats) {
  if (stats.events_added === 0) {
    console.log('📭 Yeni etkinlik yok, mail gönderilmiyor');
    return;
  }

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('is_active', true)
    .eq('confirmed', true);

  for (const sub of subs || []) {
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: sub.email,
        subject: `📅 ${stats.events_added} Yeni Etkinlik Eklendi`,
        html: `<p>Bu hafta <strong>${stats.events_added}</strong> yeni etkinlik eklendi.</p>`,
      });
    } catch (err) {
      console.warn(`Mail hatası: ${err.message}`);
    }
  }
}

// ── UTILS ─────────────────────────────────────────────────
function delay(min, max) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
}

// ── START ─────────────────────────────────────────────────
main().catch(console.error);
