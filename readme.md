# Abandon Bot

Discord-бот на Cloudflare Workers. Получает скидки и бесплатные раздачи Steam и Epic Games из RSS Game Deals, публикует новые акции и показывает списки по кнопкам в Discord.

История отправки хранится в Cloudflare KV (`DEALS_KV`). Steam-скидки определяются по игре и дате окончания; старые записи истории также учитываются.

## Cloudflare Workers

Репозиторий подключается к существующему Worker через Workers Builds. Основной скрипт `abandon_bot.js` указан в `wrangler.toml`. В поле Deploy command укажите:

```sh
npx wrangler deploy
```

Конфигурация отключает сборку, поиск дополнительных модулей и загрузку исходных карт. Статические ресурсы не настроены: в Worker загружается только основной скрипт. Отдельная команда сборки не нужна. `.gitignore` исключает из Git зависимости, временные файлы и локальные секреты, но не управляет загрузкой в Cloudflare.

Перед развёртыванием сверьте `name` с именем существующего Worker и добавьте в `wrangler.toml` привязку `DEALS_KV` к существующему namespace с историей отправок и текущее расписание Cron. Их значения в репозитории отсутствуют. Для работы также нужны `BOT_TOKEN`, `DISCORD_PUBLIC_KEY` и `DISCORD_CHANNEL_ID`. Параметр `keep_vars` сохраняет переменные из панели Cloudflare, но не заменяет настройку KV и расписания.

При ручном обновлении через редактор Cloudflare копируйте только содержимое `abandon_bot.js` в существующий Worker с его текущими настройками.

Предпросмотр новых акций без отправки: `GET /send-new-deals`. Параметр `?commit=1` запускает реальную отправку в Discord.

Подробнее: [конфигурация Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Проверка

`node --test tests/steam-dedup.cjs`
