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

// concurrency
const limit = pLimit(2);

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
      console.log('⏳ Rate limit → 15sn bekleniyor...');
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
    } catch (e) {
      console.warn('⚠️ JSON parse failed, raw output logged');
      console.log(fixed);
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

    console.log(`📋 ${sources.length} sources found`);

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
    console.error('❌ ERROR:', err);

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

  // speed boost
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

    const events = [];

    for (const link of links.slice(0, 20)) {
      try {
        const data = await scrapeEventPageRaw(context, link);

        if (data) events.push(data);

        // AI per 10 pages (SAFE MODE)
        if (events.length === 10) {
          const ai = await processAI(events, source, stats);
          events.length = 0;
        }

        await delay(400, 900);
      } catch (e) {
        console.warn('skip:', link);
      }
    }

    if (events.length > 0) {
      await processAI(events, source, stats);
    }

    await supabase
      .from('sources')
      .update({
        last_scraped_at: new Date().toISOString(),
        scraped_count: (source.scraped_count || 0) + 1,
      })
      .eq('id', source.id);

  } catch (err) {
    console.error('source error:', err.message);
  } finally {
    await context.close();
  }
}

// ── RAW SCRAPE ──────────────────────────────────────────
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

// ── AI PROCESS ──────────────────────────────────────────
async function processAI(events, source, stats) {
  const prompt = `
Extract event info.

Return ONLY valid JSON array.

FIELDS:
title, description, category, country, city, venue,
start_date, end_date,
abstract_deadline, fullpaper_deadline, early_registration_deadline,
website, cfp_link, contact_email, organizer, fee_info,
confidence

DATA:
${events.map((e, i) => `
[${i}]
url:${e.url}
title:${e.title}
content:${e.html}
`).join('\n')}
`;

  const text = await callAI(prompt);
  const json = safeJson(text);

  if (!Array.isArray(json)) return;

  const inserts = json
    .filter(e => e?.title)
    .map(e => ({
      ...e,
      source_id: source.id,
      source_url: e.website || e.url || null,
      is_new: true,
      is_active: true,
      ai_confidence_score: e.confidence || 0.5,
      ai_extracted_at: new Date().toISOString(),
      ai_model: 'llama-3.1-8b-instant',
    }));

  if (!inserts.length) return;

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
      links
        .map(a => {
          try { return new URL(a.href, base).href; }
          catch { return null; }
        })
        .filter(Boolean)
    )];
  }, baseUrl);
}

// ── NOTIFICATIONS ───────────────────────────────────────
async function sendNotifications(stats) {
  if (stats.events_added === 0) return;

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
