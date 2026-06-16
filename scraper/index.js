// scraper/index.js
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Resend } from 'resend';
import pLimit from 'p-limit';
import ws from 'ws'; 

// ── Clients ─────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
const resend = new Resend(process.env.RESEND_API_KEY);

// Aynı anda max 3 sayfa işle (rate limit aşmamak için)
const limit = pLimit(3);

// ── Ana Akış ────────────────────────────────────────────────
async function main() {
  console.log('🚀 Event Intelligence Scraper başladı...');

  // Scrape log kaydı aç
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
    // 1. is_new flaglerini sıfırla
    await supabase.rpc('reset_is_new_flags');
    console.log('✅ is_new flagleri sıfırlandı');

    // 2. Aktif kaynakları çek
    const { data: sources } = await supabase
      .from('sources')
      .select('*')
      .eq('is_active', true);

    console.log(`📋 ${sources.length} kaynak bulundu`);

    // 3. Browser başlat
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // 4. Her kaynağı tara
    const tasks = sources.map((source) =>
      limit(() => scrapeSource(browser, source, stats))
    );
    await Promise.all(tasks);

    await browser.close();

    // 5. E-mail bildirimleri gönder
    await sendNotifications(stats);

    // 6. Log güncelle
    await supabase
      .from('scrape_logs')
      .update({ ...stats, status: 'completed', finished_at: new Date().toISOString() })
      .eq('id', logId);

    console.log('✅ Scraping tamamlandı:', stats);

  } catch (err) {
    console.error('❌ Kritik hata:', err);
    await supabase
      .from('scrape_logs')
      .update({ status: 'failed', error_message: err.message, finished_at: new Date().toISOString() })
      .eq('id', logId);
    process.exit(1);
  }
}

// ── Kaynak Tarama ────────────────────────────────────────────
async function scrapeSource(browser, source, stats) {
  console.log(`🔍 Tarıyor: ${source.name} (${source.url})`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; EventBot/1.0)',
  });
  const page = await context.newPage();

  try {
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 30000 });

    // Etkinlik linklerini bul
    const eventLinks = await extractEventLinks(page, source.url);
    console.log(`  📎 ${eventLinks.length} etkinlik linki bulundu`);

    stats.sources_scraped++;
    stats.events_found += eventLinks.length;

    // Her etkinlik detay sayfasını işle
    for (const link of eventLinks.slice(0, 50)) { // kaynak başına max 50
      try {
        const eventData = await scrapeEventPage(context, link, source);
        if (eventData) {
          const result = await upsertEvent(eventData, source);
          if (result === 'added') stats.events_added++;
          else if (result === 'updated') stats.events_updated++;
          else if (result === 'duplicate') stats.events_duplicate++;
        }
        await randomDelay(1000, 2500);
      } catch (e) {
        console.warn(`  ⚠️ Link atlandı: ${link} — ${e.message}`);
      }
    }

    // Kaynak last_scraped_at güncelle
    await supabase
      .from('sources')
      .update({ last_scraped_at: new Date().toISOString(), scrape_count: source.scrape_count + 1 })
      .eq('id', source.id);

  } catch (err) {
    console.error(`  ❌ Kaynak hatası: ${source.name} — ${err.message}`);
  } finally {
    await context.close();
  }
}

// ── Etkinlik Linklerini Çıkar ────────────────────────────────
async function extractEventLinks(page, baseUrl) {
  // Sayfadaki tüm linkleri al, etkinlik gibi görünenleri filtrele
  const links = await page.evaluate((base) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors
      .map((a) => {
        try {
          return new URL(a.href, base).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }, baseUrl);

  // Etkinlik URL pattern filtresi
  const eventPatterns = [
    /\/event\//i, /\/conference\//i, /\/congress\//i,
    /\/symposium\//i, /\/seminar\//i, /\/workshop\//i,
    /\/fair\//i, /\/expo\//i, /cfp/i, /\/etkinlik\//i,
  ];

  const unique = [...new Set(links)];
  return unique.filter((url) =>
    eventPatterns.some((p) => p.test(url)) &&
    url.startsWith('http') &&
    !url.includes('#')
  );
}

// ── Etkinlik Detay Sayfası ───────────────────────────────────
async function scrapeEventPage(context, url, source) {
  const page = await context.newPage();

  try {
    // Popup'ları aynı context'te yakala
    const popupPromise = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('networkidle').catch(() => {});
    }

    const targetPage = popup || page;
    const html = await targetPage.content();
    const title = await targetPage.title();

    // PDF linkleri kontrol et
    const pdfLinks = await targetPage.evaluate(() =>
      Array.from(document.querySelectorAll('a[href$=".pdf"]')).map((a) => a.href)
    );

    // Gemini'ye gönder
    const eventData = await extractWithGemini(html, title, url, pdfLinks[0] || null);
    return eventData;

  } finally {
    await page.close();
  }
}

// ── Gemini AI Extraction ─────────────────────────────────────
async function extractWithGemini(html, pageTitle, url, pdfUrl) {
  // HTML'i kısalt (token limiti için)
  const cleanedHtml = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000); // max 8000 karakter

  const prompt = `
Aşağıdaki web sayfası içeriğinden bir etkinlik bilgisi çıkar.
Sayfa başlığı: "${pageTitle}"
Sayfa URL: ${url}

KURALLAR:
- Yalnızca emin olduğun alanları doldur
- Emin olmadığın alanları null bırak
- Tarihler ISO 8601 formatında olsun (YYYY-MM-DD)
- format alanı sadece: "online", "physical", "hybrid" veya null
- category alanı: "conference", "congress", "symposium", "fair", "workshop", "seminar" veya null
- Türkçe veya İngilizce içerik olabilir
- Sadece JSON döndür, başka hiçbir şey yazma

JSON ŞEMASI:
{
  "title": string | null,
  "description": string | null,
  "category": string | null,
  "tags": string[] | null,
  "country": string | null,
  "city": string | null,
  "venue": string | null,
  "format": "online" | "physical" | "hybrid" | null,
  "start_date": "YYYY-MM-DD" | null,
  "end_date": "YYYY-MM-DD" | null,
  "abstract_deadline": "YYYY-MM-DD" | null,
  "fullpaper_deadline": "YYYY-MM-DD" | null,
  "early_registration_deadline": "YYYY-MM-DD" | null,
  "website": string | null,
  "cfp_link": string | null,
  "contact_email": string | null,
  "organizer": string | null,
  "fee_info": string | null,
  "confidence": number
}

SAYFA İÇERİĞİ:
${cleanedHtml}
`;

  try {
    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim();

    // JSON parse
    const jsonStr = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    // Minimum confidence kontrolü
    if (!data.title || (data.confidence && data.confidence < 0.3)) {
      return null;
    }

    return {
      ...data,
      source_url: url,
      ai_extracted_at: new Date().toISOString(),
      ai_confidence_score: data.confidence || 0.5,
    };

  } catch (err) {
    console.warn(`  ⚠️ Gemini parse hatası: ${err.message}`);
    return null;
  }
}

// ── Supabase Upsert ──────────────────────────────────────────
async function upsertEvent(eventData, source) {
  // Duplicate kontrolü: aynı website veya source_url var mı?
  const checkUrl = eventData.website || eventData.source_url;
  const { data: existing } = await supabase
    .from('events')
    .select('id, title, abstract_deadline')
    .eq('source_url', eventData.source_url)
    .maybeSingle();

  if (existing) {
    // Güncelle (tarih değişmiş olabilir)
    await supabase
      .from('events')
      .update({
        abstract_deadline: eventData.abstract_deadline,
        fullpaper_deadline: eventData.fullpaper_deadline,
        early_registration_deadline: eventData.early_registration_deadline,
        description: eventData.description,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 'updated';
  }

  // Yeni kayıt ekle
  const { error } = await supabase.from('events').insert({
    ...eventData,
    source_id: source.id,
    is_new: true,
    is_active: true,
  });

  if (error) {
    console.warn(`  ⚠️ Insert hatası: ${error.message}`);
    return 'error';
  }
  return 'added';
}

// ── E-mail Bildirimleri ──────────────────────────────────────
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

  if (!subs || subs.length === 0) return;

  // Yeni etkinlikleri çek
  const { data: newEvents } = await supabase
    .from('events')
    .select('title, category, country, start_date, abstract_deadline, website')
    .eq('is_new', true)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(20);

  // Yaklaşan deadline'ları çek
  const { data: deadlineEvents } = await supabase
    .from('upcoming_deadlines')
    .select('*')
    .limit(10);

  for (const sub of subs) {
    try {
      if (sub.weekly_summary || sub.new_events) {
        await sendWeeklySummaryEmail(sub, newEvents, deadlineEvents, stats);
      }

      await supabase.from('notification_logs').insert({
        subscription_id: sub.id,
        email: sub.email,
        type: 'weekly_summary',
        events_count: newEvents?.length || 0,
        status: 'sent',
      });

    } catch (err) {
      console.warn(`  ⚠️ Mail gönderilemedi: ${sub.email} — ${err.message}`);
      await supabase.from('notification_logs').insert({
        subscription_id: sub.id,
        email: sub.email,
        type: 'weekly_summary',
        status: 'failed',
      });
    }
  }
}

async function sendWeeklySummaryEmail(sub, newEvents, deadlineEvents, stats) {
  const newEventRows = (newEvents || []).map((e) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${e.title || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${e.category || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${e.country || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${e.abstract_deadline || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">
        ${e.website ? `<a href="${e.website}">Link</a>` : '-'}
      </td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:700px;margin:auto;padding:20px">
  <h2 style="color:#1e40af">📅 Haftalık Etkinlik Raporu</h2>
  <p>Bu hafta <strong>${stats.events_added}</strong> yeni etkinlik eklendi.</p>

  <h3>🆕 Yeni Etkinlikler</h3>
  <table width="100%" cellspacing="0" style="border-collapse:collapse">
    <thead>
      <tr style="background:#f1f5f9">
        <th style="padding:8px;text-align:left">Etkinlik</th>
        <th style="padding:8px;text-align:left">Kategori</th>
        <th style="padding:8px;text-align:left">Ülke</th>
        <th style="padding:8px;text-align:left">Özet Son</th>
        <th style="padding:8px;text-align:left">Link</th>
      </tr>
    </thead>
    <tbody>${newEventRows}</tbody>
  </table>

  <p style="margin-top:24px;color:#64748b;font-size:12px">
    Bu maili almak istemiyorsanız 
    <a href="${process.env.NEXT_PUBLIC_APP_URL}/unsubscribe?email=${sub.email}">
      buraya tıklayın
    </a>.
  </p>
</body>
</html>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: sub.email,
    subject: `📅 Bu Hafta ${stats.events_added} Yeni Etkinlik — Event Intelligence`,
    html,
  });
}

// ── Yardımcılar ──────────────────────────────────────────────
function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise((r) => setTimeout(r, ms));
}

// ── Başlat ───────────────────────────────────────────────────
main().catch(console.error);
