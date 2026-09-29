# Abandon Bot

Discord-бот на Cloudflare Workers. Получает скидки и бесплатные раздачи Steam и Epic Games из RSS Game Deals, публикует новые акции и показывает списки по кнопкам в Discord.

История отправки хранится в Cloudflare KV (`DEALS_KV`). Steam-скидки определяются по игре и дате окончания; старые записи истории также учитываются.

## Cloudflare Workers

Репозиторий подключается к существующему Worker через Workers Builds. В поле Deploy command укажите:

```sh
npx wrangler deploy abandon_bot.js
```

Команда явно задаёт основной скрипт. README, инструкции и тесты не импортируются скриптом и не являются статическими ресурсами для загрузки. Отдельная команда сборки не нужна. `.gitignore` исключает из Git зависимости, временные файлы и локальные секреты, но не управляет загрузкой в Cloudflare.

Для работы боту нужны привязка `DEALS_KV` к существующему namespace с историей отправок, `BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_CHANNEL_ID` и расписание Cron. Указание файла в команде само по себе не настраивает эти параметры и не гарантирует сохранение настроек при развёртывании; проверяйте их в существующем Worker.

При ручном обновлении через редактор Cloudflare копируйте только содержимое `abandon_bot.js` в существующий Worker с его текущими настройками.

Предпросмотр новых акций без отправки: `GET /send-new-deals`. Параметр `?commit=1` запускает реальную отправку в Discord.

Подробнее: [конфигурация Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Проверка

`node --test tests/steam-dedup.cjs`
