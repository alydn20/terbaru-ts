// migrate.mjs — Migrasi data dari Upstash ke Redis Cloud
// Jalankan: node migrate.mjs REDIS_CLOUD_URL
// Contoh: node migrate.mjs "redis://default:PASSWORD@redis-14743.c10.us-east-1-3.ec2.cloud.redislabs.com:14743"

import { Redis as Upstash } from '@upstash/redis'
import IORedis from 'ioredis'

const UPSTASH_URL = 'https://robust-mole-31555.upstash.io'
const UPSTASH_TOKEN = 'AXtDAAIncDIxOWMyMWMzYjQ0MjI0MzJlYWQwNTRkMzM0MjgxYWIxNXAyMzE1NTU'

const REDIS_CLOUD_URL = process.argv[2]
if (!REDIS_CLOUD_URL) {
  console.error('Usage: node migrate.mjs "redis://default:PASSWORD@host:port"')
  process.exit(1)
}

const KEYS = {
  DAILY_STATS: 'gold:daily_stats',
  PRICE_HISTORY: 'gold:price_history',
  USERS: 'gold:users',
  PUSH_SUBS: 'gold:push_subs',
  SESSIONS: 'gold:sessions',
  WA_GROUP_ID: 'gold:wa_group_id',
  WA_BROADCAST_GROUP_ID: 'gold:wa_broadcast_group_id',
  OTP_CODES: 'gold:otp_codes',
  LOGIN_TOKENS: 'gold:login_tokens',
  LOGIN_ATTEMPTS: 'gold:login_attempts',
  BLOCKED_USERS: 'gold:blocked_users',
  PENDING_REGISTRATIONS: 'gold:pending_reg_v2',
  USER_PINS: 'gold:user_pins',
  SOUND_SETTINGS: 'gold:sound_settings',
  NOMINAL_SETTINGS: 'gold:nominal_settings',
  NOTIF_HISTORY: 'gold:notif_history',
  PROMO_LIMIT: 'gold:promo_limit',
  LOWEST_ON_PRICE: 'gold:lowest_on_price',
  LOWEST_ON_DATE: 'gold:lowest_on_date',
  NTFY_SETTINGS: 'gold:ntfy_settings'
}

const src = new Upstash({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
const dst = new IORedis(REDIS_CLOUD_URL, { maxRetriesPerRequest: 3 })

async function migrate() {
  console.log('Memulai migrasi Upstash → Redis Cloud...\n')
  let ok = 0, skip = 0

  for (const [name, key] of Object.entries(KEYS)) {
    // Skip WA_AUTH — sudah pakai file lokal
    if (name === 'WA_AUTH') { console.log(`  SKIP  ${key} (WA auth pakai file lokal)`); skip++; continue }

    try {
      // Cek tipe dulu
      const type = await src.type(key)

      if (type === 'hash') {
        const hash = await src.hgetall(key)
        if (hash && Object.keys(hash).length > 0) {
          const args = []
          for (const [f, v] of Object.entries(hash)) args.push(f, typeof v === 'string' ? v : JSON.stringify(v))
          await dst.hset(key, ...args)
          console.log(`  HASH  ${key} (${Object.keys(hash).length} fields)`)
          ok++; continue
        }
      } else if (type === 'list') {
        const list = await src.lrange(key, 0, -1)
        if (list && list.length > 0) {
          await dst.del(key)
          await dst.rpush(key, ...list.map(v => typeof v === 'string' ? v : JSON.stringify(v)))
          console.log(`  LIST  ${key} (${list.length} items)`)
          ok++; continue
        }
      } else if (type === 'string') {
        const str = await src.get(key)
        if (str !== null && str !== undefined) {
          await dst.set(key, typeof str === 'string' ? str : JSON.stringify(str))
          console.log(`  STR   ${key}`)
          ok++; continue
        }
      } else if (type === 'none') {
        console.log(`  EMPTY ${key} (kosong, skip)`)
        skip++; continue
      } else {
        console.log(`  SKIP  ${key} (tipe: ${type})`)
        skip++; continue
      }

      console.log(`  EMPTY ${key} (kosong, skip)`)
      skip++
    } catch (e) {
      console.error(`  ERROR ${key}: ${e.message}`)
      skip++
    }
  }

  console.log(`\nSelesai! ${ok} key berhasil, ${skip} skip/kosong`)
  dst.disconnect()
}

migrate().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
