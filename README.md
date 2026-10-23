# Steppe Sentinel — инструкция для Арсения

Арсений, этот файл объясняет проект простыми словами: из каких частей он состоит, что записать в `.env`, как запустить свою базу данных и как подключить свой аккаунт Copernicus.

## Что делает проект

Steppe Sentinel помогает наблюдать за пастбищами по спутниковым снимкам Sentinel-2.

Обычный порядок работы такой:

1. Пользователь регистрируется или входит в систему.
2. На карте рисует границу пастбища.
3. Система ищет снимки Sentinel-2 за выбранный год.
4. Фоновый обработчик загружает спектральные каналы и считает NDVI и NDMI.
5. Результат сохраняется в PostgreSQL.
6. На карте появляются цветной растр, показатели и статистика.
7. ML-модуль группирует похожие спектральные пиксели и формирует объяснимое заключение.

NDVI показывает активность зелёной растительности. NDMI показывает относительную влажность растительного покрова. Эти индексы не являются прямой оценкой кормовой ценности или допустимой нагрузки скота.

## Структура проекта

```text
arsenndvi/
├── apps/
│   ├── frontend/       интерфейс сайта Steppe Sentinel
│   ├── backend/        REST API, регистрация, роли и работа с базой
│   └── worker/         фоновые задачи Copernicus, NDVI, NDMI и ML
├── packages/
│   ├── gis/            проверка полигонов и расчёт площади
│   ├── satellite/      запросы к Copernicus Data Space
│   ├── ml/             спектральные признаки и ML-кластеризация
│   └── shared/         общие типы и правила для всех частей проекта
├── database/
│   └── migrations/     таблицы PostgreSQL и изменения структуры базы
├── docker/             инструкции сборки Docker-образов
├── docker-compose.yml  запуск всех сервисов одной командой
├── .env.example        безопасный пример настроек
└── README.md           эта инструкция
```

### `frontend`

Это всё, что Арсений видит в браузере: вход, карта, пастбища, NDVI/NDMI, ML-заключение, отчёты, настройки и управление пользователями. Интерфейс работает на русском, казахском и английском языках.

### `backend`

Backend принимает запросы от интерфейса, проверяет пользователя и роль, читает и записывает данные в PostgreSQL. Пароли сохраняются только в виде `scrypt`-хеша. Сессия передаётся через защищённую `HttpOnly` cookie.

### `worker`

Worker выполняет долгую работу в фоне: ищет снимки, загружает каналы Sentinel-2, создаёт месячные композиты, считает индексы и запускает ML-анализ. Очередь задач хранится в Redis.

### `postgres`

PostgreSQL с расширением PostGIS хранит пользователей, полигоны пастбищ, спутниковые сцены, статистику и растры. Docker сохраняет базу в отдельном томе `postgres_data`, поэтому обычный перезапуск контейнеров данные не удаляет.

### `redis`

Redis хранит очередь фоновых задач. Например, после нажатия «Найти Sentinel-2» backend добавляет задачу в Redis, а worker забирает и выполняет её.

## Что нужно установить

Арсений, для самого простого запуска нужны:

- Docker Desktop;
- Docker Compose, который уже входит в Docker Desktop;
- минимум 4 ГБ свободной оперативной памяти;
- свободные порты `3000` и `4000`.

Node.js, PostgreSQL, Redis и GDAL отдельно устанавливать не требуется: Docker поднимет их сам.

## Создание файла `.env`

В корне проекта уже есть `.env.example`. Скопируй его в `.env`.

PowerShell:

```powershell
Copy-Item .env.example .env
```

Linux или macOS:

```bash
cp .env.example .env
```

Файл `.env` содержит пароли и секрет Copernicus. Он уже добавлен в `.gitignore`. Не отправляй его в GitHub и не пересылай посторонним.

## Готовый `.env` для первого демонстрационного запуска

С этим вариантом Copernicus пока не нужен. Система создаст демонстрационные спутниковые данные.

```dotenv
NODE_ENV=development
DEMO_MODE=true

POSTGRES_DB=steppe_sentinel
POSTGRES_USER=arseniy
POSTGRES_PASSWORD=CHANGE_ME_DB_PASSWORD_2026
DATABASE_URL=postgresql://arseniy:CHANGE_ME_DB_PASSWORD_2026@postgres:5432/steppe_sentinel
REDIS_URL=redis://redis:6379

API_PORT=4000
FRONTEND_PORT=3000
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000/api
NEXT_PUBLIC_DEMO_MODE=true

COPERNICUS_CLIENT_ID=
COPERNICUS_CLIENT_SECRET=
COPERNICUS_TIMEOUT_MS=30000

COOKIE_SECURE=false
ADMIN_EMAIL=arseniy@example.com
ADMIN_PASSWORD=CHANGE_ME_ADMIN_PASSWORD_2026
ADMIN_NAME=Арсений

MAX_POLYGON_AREA_HA=250000
MAX_GEOMETRY_POINTS=5000
MAX_RASTER_BYTES=52428800
WORKER_CONCURRENCY=2
```

Арсений, обязательно замени:

- `CHANGE_ME_DB_PASSWORD_2026` — в двух местах на один и тот же пароль базы;
- `arseniy@example.com` — на свой email;
- `CHANGE_ME_ADMIN_PASSWORD_2026` — на свой пароль администратора.

Пароль администратора должен содержать минимум 10 символов, хотя бы одну букву и одну цифру.

## Как настроить свою базу PostgreSQL

Для обычного запуска отдельный сервер PostgreSQL не нужен. Docker создаст личную локальную базу Арсения из этих четырёх строк:

```dotenv
POSTGRES_DB=steppe_sentinel
POSTGRES_USER=arseniy
POSTGRES_PASSWORD=ТВОЙ_ПАРОЛЬ_БАЗЫ
DATABASE_URL=postgresql://arseniy:ТВОЙ_ПАРОЛЬ_БАЗЫ@postgres:5432/steppe_sentinel
```

Значения должны совпадать:

- после `postgresql://` указывается `POSTGRES_USER`;
- после двоеточия указывается `POSTGRES_PASSWORD`;
- после `:5432/` указывается `POSTGRES_DB`;
- слово `postgres` в адресе — это имя Docker-сервиса, его менять не нужно.

Для простоты используй в пароле базы латинские буквы, цифры, дефис и подчёркивание. Символы `@`, `:`, `/`, `#` внутри `DATABASE_URL` необходимо кодировать, поэтому при первом запуске лучше их не использовать.

Таблицы создаются автоматически при запуске backend. Миграции лежат в `database/migrations`.

### Если PostgreSQL установлен отдельно

Внешняя база должна поддерживать PostGIS и `pgcrypto`. Для PostgreSQL на том же Windows-компьютере, когда backend работает внутри Docker, адрес обычно выглядит так:

```dotenv
DATABASE_URL=postgresql://arseniy:ТВОЙ_ПАРОЛЬ@host.docker.internal:5432/steppe_sentinel
```

В этом случае заранее создай базу и пользователя на внешнем сервере. Локальный контейнер `postgres` всё равно запустится из-за текущей схемы Docker Compose, но backend будет использовать адрес из `DATABASE_URL`.

## Как подключить свой Copernicus

Арсений, сначала зарегистрируйся в Copernicus Data Space Ecosystem. В личном кабинете создай OAuth/API client типа Client Credentials. Сервис выдаст два значения:

- Client ID;
- Client Secret.

Запиши их только в `.env`:

```dotenv
DEMO_MODE=false
NEXT_PUBLIC_DEMO_MODE=false
COPERNICUS_CLIENT_ID=ВСТАВЬ_СВОЙ_CLIENT_ID
COPERNICUS_CLIENT_SECRET=ВСТАВЬ_СВОЙ_CLIENT_SECRET
COPERNICUS_TIMEOUT_MS=30000
```

После изменения этих значений обязательно пересобери контейнеры:

```bash
docker compose up -d --build
```

Если `DEMO_MODE=true`, система работает на демонстрационных данных и не обращается к Copernicus. Если `DEMO_MODE=false`, пустые или неправильные Client ID/Secret приведут к ошибке поиска снимков.

Никогда не записывай Client Secret в README, исходный код или `.env.example`. Если секрет уже публиковался, его нужно отозвать в Copernicus и создать новый.

## Администратор и клиент

Bootstrap-администратор создаётся из:

```dotenv
ADMIN_EMAIL=arseniy@example.com
ADMIN_PASSWORD=ТВОЙ_НАДЁЖНЫЙ_ПАРОЛЬ
ADMIN_NAME=Арсений
```

При каждом запуске backend эта учётная запись получает роль `ADMIN` и пароль из `.env`.

Роли работают так:

- `CLIENT` использует карту, Sentinel-2, NDVI/NDMI, ML-заключения и отчёты;
- `ADMIN` имеет те же возможности и дополнительно видит раздел «Пользователи»;
- новая самостоятельная регистрация всегда создаёт `CLIENT`;
- администратор может назначать роли и блокировать пользователей;
- последнего активного администратора нельзя заблокировать или сделать клиентом.

## Запуск проекта

Из корня проекта выполни:

```bash
docker compose up -d --build
```

Первый запуск может занять несколько минут. Docker скачает образы, соберёт frontend/backend/worker, создаст базу и применит миграции.

Проверить состояние:

```bash
docker compose ps
```

В колонке `STATUS` сервисы `postgres`, `redis`, `backend` и `frontend` должны стать `healthy`. Worker должен иметь состояние `Up`.

После запуска:

- сайт: http://localhost:3000;
- API: http://localhost:4000/api;
- документация API: http://localhost:4000/api/docs.

Войди с `ADMIN_EMAIL` и `ADMIN_PASSWORD`, которые указаны в твоём `.env`.

## Остановка и повторный запуск

Остановить контейнеры, сохранив данные:

```bash
docker compose down
```

Запустить снова:

```bash
docker compose up -d
```

Команда `docker compose down -v` удаляет тома вместе с базой PostgreSQL. Не используй ключ `-v`, если данные нужно сохранить.

## Полезные команды

Показать логи backend:

```bash
docker compose logs -f backend
```

Показать логи worker:

```bash
docker compose logs -f worker
```

Пересобрать проект после изменения кода или `.env`:

```bash
docker compose up -d --build
```

Запустить проверки исходного кода:

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Что происходит после нажатия «Найти Sentinel-2»

1. Backend проверяет пользователя, полигон и выбранный год.
2. Задача записывается в Redis.
3. Worker ищет сцены за май–сентябрь.
4. Сначала проверяется покрытие полигона, затем облачность внутри AOI по SCL.
5. Подходящие даты сохраняются в PostgreSQL.
6. Интерфейс показывает прогресс фоновой задачи.

После этого кнопка «Построить NDVI-композит» загружает отражение B02–B12, исключает воду, облака, тени, снег и невалидные пиксели, строит месячный медианный композит и считает NDVI/NDMI.

## Частые проблемы

### Сайт не открывается

Проверь:

```bash
docker compose ps
docker compose logs --tail 100 backend
docker compose logs --tail 100 frontend
```

### Backend не подключается к PostgreSQL

Проверь, что `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` совпадают с данными внутри `DATABASE_URL`. Для Docker используй хост `postgres`, а не `localhost`.

### Copernicus возвращает 401 или 403

Обычно неверны Client ID или Client Secret. Создай новый OAuth client и пересобери backend/worker.

### Copernicus возвращает ошибку размера пикселя

Это означает, что слишком большой полигон запрашивается с недостаточным размером выходного изображения. Worker должен автоматически подбирать допустимые размеры, но очень большой полигон лучше разделить на несколько территорий.

### После изменения `.env` ничего не изменилось

Пересобери контейнеры:

```bash
docker compose up -d --build
```

### Нужно полностью начать заново

Сначала сделай резервную копию. Удаление Docker volume уничтожит пользователей, полигоны, статистику и растры без возможности восстановления.

## Важное напоминание для Арсения

Арсений, для первого знакомства начинай с `DEMO_MODE=true`. Когда карта, регистрация и обработка заработают, добавь свой Client ID/Secret Copernicus, переключи `DEMO_MODE=false` и пересобери проект. Так проще понять, связана ли возможная ошибка с проектом или с внешним сервисом Copernicus.
