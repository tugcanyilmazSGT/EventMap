// ============================================================
// KONGREARA.COM ENTEGRASYONu — index.js'e eklenecek kod
// ============================================================
//
// AŞAĞIDAKİ ADIMLARI UYGULA:
//
// 1) Dosya yapısı:
//    scraper/
//      index.js
//      sources/
//        kongreara.js   ← az önce verdiğim dosya, buraya koy
//
// 2) index.js'in en üstüne import ekle:

import { scrapeKongreAra, mapKongreAraEvent } from './sources/kongreara.js';

// ============================================================
// 3) main() fonksiyonunun içinde, browser açıldıktan sonra,
//    normal kaynak taramasından ÖNCE veya SONRA şu bloğu ekle:
// ============================================================

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

      const eventData = mapKongreAraEvent(raw, null); // source_id null, aşağıda set edilecek

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

// ============================================================
// 4) main() içindeki şu satırı:
//
//    await Promise.all(
//      sources.map(source => limit(() => scrapeSource(browser, source, stats)))
//    );
//
//    ŞUNUNLA DEĞİŞTİR (kongreara'yı paralel listeye ekle):
// ============================================================

await Promise.all([
  ...sources.map(source => limit(() => scrapeSource(browser, source, stats))),
  scrapeKongreAraSource(browser, stats),
]);

// ============================================================
// NOT: kongreara.com Supabase'deki "sources" tablosunda
// bir satır olarak GÖRÜNMEYECEK çünkü ayrı bir fonksiyonla
// taranıyor. İstersen takip için sources tablosuna ekleyebilirsin:
// ============================================================

/*
SQL:
INSERT INTO sources (name, url, category, is_active)
VALUES ('Kongre Ara (Direct Parse)', 'https://kongreara.com', 'general', true)
ON CONFLICT (url) DO NOTHING;
*/
