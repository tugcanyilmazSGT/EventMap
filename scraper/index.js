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

// ⚡ concurrency (OPTIMAL: 2-3)
const limit = pLimit(3);

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
        max_tokens: 600,
      }),
    });

    const data = await response.json();

    if (data.error?.message?.includes('Rate limit')) {
      console.log('⏳ Rate limit 15sn bekleniyor...');
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    if (data.error) throw new Error(data.error.message);

    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  throw new Error('AI failed after retries');
}

// ── SAFE JSON PARSER ────────────────────────────────────
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fixed = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .replace(/[\u0000-\u001F]+/g, '')
      .trim();

    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

// ── MAIN ────────────────────────────────────────────────
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

    console.log(`📋 ${sources.length} sources`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    await Promise.all(
      sources.map(source =>
        limit(() => scrapeSource(browser, source, stats))
      )
    );

    await browser.close();

    await sendNotifications(stats);

    await supabase
      .from('scrape_logs')
      .update({
        ...stats,
        status: 'completed',
        finished_at: new Date().toISOString(),
      })
      .eq('id', logId);

    console.log('✅ DONE:', stats);

  } catch (err) {
    console.error(err);

    await supabase
      .from('scrape_logs')
      .update({
        status: 'failed',
        error_message: err.message,
        finished_at: new Date().toISOString(),
      })
      .eq('id', logId);

    process.exit(1);
  }
}

// ── SOURCE SCRAPER ──────────────────────────────────────
async function scrapeSource(browser, source, stats) {
  console.log(`🔍 ${source.name}`);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  });

  // ⚡ SPEED BOOST: block heavy resources
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  const page = await context.newPage();

  try {
    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const links = await extractEventLinks(page, source.url);
    console.log(`📎 ${links.length} links`);

    stats.sources_scraped++;
    stats.events_found += links.length;

    const pages = [];

    for (const link of links.slice(0, 20)) {
      try {
        const data = await scrapeEventPageRaw(context, link);

        if (data) pages.push(data);

        // ⚡ batch AI every 10 pages
        if (pages.length === 10) {
          const aiResults = await extractBatchWithAI(pages);

          if (aiResults) {
            await processAIResults(aiResults, source, stats);
          }

          pages.length = 0;
        }

        await delay(400, 900);
      } catch (e) {
        console.warn('skip:', link);
      }
    }

    // remaining batch
    if (pages.length > 0) {
      const aiResults = await extractBatchWithAI(pages);
      if (aiResults) {
        await processAIResults(aiResults, source, stats);
      }
    }

    await supabase
      .from('sources')
      .update({
        last_scraped_at: new Date().toISOString(),
        scrape_count: source.scrape_count + 1,
      })
      .eq('id', source.id);

  } catch (err) {
    console.error('source error:', err.message);
  } finally {
    await context.close();
  }
}

// ── RAW SCRAPE (NO AI) ──────────────────────────────────
async function scrapeEventPageRaw(context, url) {
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const html = await page.content();
    const title = await page.title();

    return {
      url,
      title,
      html: html.slice(0, 2000),
    };

  } finally {
    await page.close();
  }
}

// ── BATCH AI ────────────────────────────────────────────
async function extractBatchWithAI(pages) {
  const prompt = `
Extract events. Return ONLY JSON array.

RULES:
- valid JSON only
- no markdown
- null if unknown

FIELDS:
title, description, city, country, start_date, end_date, website, confidence

PAGES:
${pages.map((p, i) => `
[${i}]
title:${p.title}
url:${p.url}
content:${p.html}
`).join('\n')}
`;

  const text = await callAI(prompt);
  return safeJson(text);
}

// ── PROCESS AI ──────────────────────────────────────────
async function processAIResults(results, source, stats) {
  if (!Array.isArray(results)) return;

  const inserts = [];

  for (const r of results) {
    if (!r?.title) continue;

    inserts.push({
      ...r,
      source_id: source.id,
      source_url: r.website,
      is_new: true,
      is_active: true,
      ai_confidence_score: r.confidence || 0.5,
      ai_extracted_at: new Date().toISOString(),
    });
  }

  if (inserts.length === 0) return;

  const { error } = await supabase
    .from('events')
    .upsert(inserts, { onConflict: 'source_url' });

  if (!error) {
    stats.events_added += inserts.length;
  }
}

// ── LINKS ───────────────────────────────────────────────
async function extractEventLinks(page, baseUrl) {
  return page.evaluate((base) => {
    const links = [...document.querySelectorAll('a[href]')];
    return [...new Set(
      links.map(a => {
        try { return new URL(a.href, base).href; }
        catch { return null; }
      }).filter(Boolean)
    )];
  }, baseUrl);
}

// ── EMAIL (unchanged) ───────────────────────────────────
async function sendNotifications(stats) {
  if (stats.events_added === 0) return;

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('is_active', true)
    .eq('confirmed', true);

  const { data: newEvents } = await supabase
    .from('events')
    .select('*')
    .eq('is_new', true)
    .limit(20);

  for (const sub of subs || []) {
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: sub.email,
        subject: `📅 ${stats.events_added} Yeni Etkinlik`,
        html: `<p>${stats.events_added} yeni etkinlik eklendi.</p>`,
      });
    } catch {}
  }
}

// ── UTILS ───────────────────────────────────────────────
function delay(min, max) {
  return new Promise(r =>
    setTimeout(r, Math.floor(Math.random() * (max - min) + min))
  );
}

// ── START ───────────────────────────────────────────────
main().catch(console.error);
