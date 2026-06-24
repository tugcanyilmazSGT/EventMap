// scraper/sources/kongreara.js
// kongreara.com için özel parser - AI'sız, doğrudan Next.js JSON verisinden çekiyor
// Tüm sayfaları (pagination) takip eder çünkü AI rate limit'i yok.

/**
 * kongreara.com sayfa kaynağında gömülü __next_f JSON verisini çıkarır.
 * Next.js server-side render edilmiş veriyi script tag'leri içinde tutar.
 * Her arama terimi için TÜM sayfaları gezer (etkinlik bitene kadar).
 */
export async function scrapeKongreAra(context, baseUrl = 'https://kongreara.com') {
  const page = await context.newPage();
  const allEvents = [];

  try {
    const searchTerms = ['kongre', 'konferans', 'sempozyum', 'fuar'];
    const maxPagesPerTerm = 60; // güvenlik sınırı, normalde çok daha az sayfada biter

    for (const term of searchTerms) {
      let emptyStreak = 0;

      for (let pageNum = 1; pageNum <= maxPagesPerTerm; pageNum++) {
        const url = pageNum === 1
          ? `${baseUrl}/arama?q=${encodeURIComponent(term)}`
          : `${baseUrl}/arama?q=${encodeURIComponent(term)}&page=${pageNum}`;

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
          console.warn(`    ⚠️ Sayfa yüklenemedi: ${url} — ${e.message}`);
          break;
        }

        const html = await page.content();
        const events = extractEventsFromHtml(html);

        if (events.length === 0) {
          emptyStreak++;
          console.log(`    📦 "${term}" sayfa ${pageNum}: 0 etkinlik`);
          if (emptyStreak >= 2) {
            console.log(`    ⏹️  "${term}" için tarama bitti (sayfa ${pageNum})`);
            break;
          }
        } else {
          emptyStreak = 0;
          console.log(`    📦 "${term}" sayfa ${pageNum}: ${events.length} etkinlik`);
          allEvents.push(...events);
        }

        await new Promise(r => setTimeout(r, 800)); // nazik bekleme
      }
    }

  } catch (err) {
    console.error(`  ❌ kongreara.com hatası: ${err.message}`);
  } finally {
    await page.close();
  }

  // Duplicate temizliği (aynı id birden fazla arama teriminde/sayfada çıkabilir)
  const uniqueEvents = Array.from(
    new Map(allEvents.map(e => [e.id, e])).values()
  );

  console.log(`  ✅ kongreara.com toplam: ${uniqueEvents.length} benzersiz etkinlik`);
  return uniqueEvents;
}

/**
 * HTML içindeki self.__next_f.push([1,"..."]) bloklarından
 * "events":[...] dizisini regex ile çıkarır ve parse eder.
 */
function extractEventsFromHtml(html) {
  const events = [];

  const pushBlocks = html.match(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g) || [];

  for (const block of pushBlocks) {
    const match = block.match(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/);
    if (!match) continue;

    let raw = match[1];

    raw = raw
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\u0026/g, '&');

    const eventsMatch = raw.match(/"events":(\[.*?\]),"pageSize"/s);
    if (!eventsMatch) continue;

    try {
      const parsed = JSON.parse(eventsMatch[1]);
      events.push(...parsed);
    } catch (e) {
      continue;
    }
  }

  return events;
}

/**
 * format alanını string'e çevirir (0=fiziksel, 1=online, 2=hibrit)
 * İngilizce döndürüyor çünkü Supabase constraint'i öyle istiyor.
 */
function mapFormat(formatCode) {
  const map = { 0: 'physical', 1: 'online', 2: 'hybrid' };
  return map[formatCode] || null;
}

/**
 * categoryNames dizisini bizim kategori sistemimize eşler.
 * kongreara'da kategori "alan" anlamına geliyor (Tıp, Mühendislik vb),
 * bizim sistemde "tür" (kongre/konferans/sempozyum/fuar).
 * Başlıktan tür çıkarımı yapıyoruz. İngilizce döndürüyor.
 */
function inferCategory(title) {
  const t = title.toLowerCase();
  if (t.includes('sempozyum') || t.includes('symposium')) return 'symposium';
  if (t.includes('kongre') || t.includes('congress')) return 'congress';
  if (t.includes('konferans') || t.includes('conference')) return 'conference';
  if (t.includes('fuar') || t.includes('expo') || t.includes('fair')) return 'fair';
  if (t.includes('çalıştay') || t.includes('workshop')) return 'workshop';
  return 'congress'; // varsayılan, çoğu kayıt kongre
}

/**
 * kongreara.com event objesini bizim Supabase events şemamıza dönüştürür.
 */
export function mapKongreAraEvent(raw, sourceId) {
  return {
    title: raw.title,
    category: inferCategory(raw.title),
    city: raw.cityName && raw.cityName !== '—' && raw.cityName !== 'null' ? raw.cityName : null,
    country: raw.countryName || null,
    format: mapFormat(raw.format),
    website: raw.websiteUrl || raw.sourceUrl,
    start_date: raw.startDate ? raw.startDate.split('T')[0] : null,
    end_date: raw.endDate ? raw.endDate.split('T')[0] : null,
    organizer: raw.organizer && raw.organizer !== '—' ? raw.organizer : null,
    source_url: raw.sourceUrl || `https://kongreara.com/etkinlik/${raw.slug}`,
    source_id: sourceId,
    ai_confidence_score: 1.0, // AI kullanılmadı, kaynak veri direkt yapılandırılmış
    ai_extracted_at: new Date().toISOString(),
    ai_model: 'direct-parse', // AI değil, doğrudan JSON parse
    is_new: true,
    is_active: true,
  };
}
