# Trend Botu

ETH/USDC alıp satan, Arbitrum One üzerinde çalışan trend takip botu. Kâr garantisi yoktur.

## Parçalar
- `index.html`: kontrol paneli (GitHub Pages bunu yayınlar). MetaMask bağlantısı, bot cüzdanı, para yatırma/çekme, geçmiş testi, simülasyon.
- `bot/run.js`: sunucu botu. GitHub Actions yaklaşık 10 dakikada bir çalıştırır; telefon kapalıyken de izler.
- `bot/config.json`: sunucu botunun ayarları. `"live": false` iken sanal hesapla çalışır, gerçek işlem göndermez.
- `state/state.json`: sunucu botunun yazdığı durum; panel bunu gösterir.

## Kurulum sırası
1. Depo ayarlarında Pages'i aç: Settings → Pages → Deploy from a branch → `main` / root.
2. Paneli MetaMask uygulamasının tarayıcısında aç, Cüzdan sekmesindeki adımları tamamla (bot cüzdanı, para yatırma, ön kontrol, 1 USDC testi).
3. Sunucu botu önce deneme modunda çalışır. Panelde "Sunucu botu" kutusunu birkaç gün izle.
4. Gerçek paraya geçmek için: panelde "Yedek anahtarı göster" ile bot cüzdanının anahtarını al, depoda Settings → Secrets and variables → Actions → New repository secret ile `BOT_PRIVATE_KEY` adıyla kaydet. Anahtarı başka hiçbir yere yapıştırma.
5. `bot/config.json` içinde `"live": true` yap.

## Bilinmesi gerekenler
- Sunucu botu gerçek paradayken tarayıcıdaki botu gerçek parayla çalıştırma; panel bunu engeller.
- GitHub zamanlayıcısı bazen 10-20 dakika gecikir. Stop, bir sonraki çalıştırmada uygulanır.
- Kalıcı bir güvenlik freni devreye girerse iş akışı "başarısız" görünür ve GitHub e-posta gönderir. Freni kaldırmak için: Actions → Trend Botu → Run workflow → "Güvenlik frenini kaldır".
- Durdurmak için: `"live": false` yap ya da Actions sekmesinden iş akışını devre dışı bırak. Parayı panelden "Hepsini MetaMask'a çek" ile al.
