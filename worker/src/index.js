// ── 검키우기 대장간 서버 (Cloudflare Workers + Durable Objects) ──
// 게임 규칙은 아래 「게임 코드」(원래 구글 앱스 스크립트 Code.gs)를 그대로 씁니다.
// 여기 머리 부분은 구글 기능(시트·캐시·잠금·해시·날짜)을 Durable Object 의 SQLite 저장소로 바꿔 끼우는 층입니다.
import { DurableObject } from "cloudflare:workers";

const SITE_URL = "https://ruddls0814-debug.github.io/sword/";
let DB = null;   // 지금 요청을 처리 중인 Durable Object 의 저장소와 메모리 사본

// 날짜는 시트처럼 Date 로 되돌려 줍니다
const enc = v => (v instanceof Date ? { $d: v.toISOString() } : v);
const dec = v => (v && typeof v === "object" && v.$d ? new Date(v.$d) : v);

// ── 시트 흉내: 행 배열을 메모리에 두고, 바뀐 행만 SQLite 에 씁니다 ──
class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows; this.dirty = new Set(); this.full = false; }
  getLastRow() { return this.rows.length; }
  appendRow(a) { this.rows.push(a.slice()); this.dirty.add(this.rows.length); DB.touched.add(this); }
  setFrozenRows() {}
  deleteRows(start, n) { this.rows.splice(start - 1, n); this.full = true; DB.touched.add(this); }
  deleteRow(r) { this.deleteRows(r, 1); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    const get = () => { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || [], o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined || v === null ? "" : v); } out.push(o); } return out; };
    const set = vals => { for (let i = 0; i < vals.length; i++) { const ri = r - 1 + i; while (sh.rows.length <= ri) sh.rows.push([]); const row = sh.rows[ri]; for (let j = 0; j < vals[i].length; j++) { while (row.length < c - 1 + j) row.push(""); row[c - 1 + j] = vals[i][j]; } sh.dirty.add(ri + 1); } DB.touched.add(sh); };
    return { getValues: get, getValue: () => get()[0][0], setValues: set, setValue: v => set([[v]]) };
  }
  flush(sql) {
    if (this.full) {
      sql.exec("DELETE FROM cells WHERE sheet = ?", this.name);
      this.rows.forEach((row, i) => sql.exec("INSERT INTO cells (sheet, r, data) VALUES (?, ?, ?)", this.name, i + 1, JSON.stringify(row.map(enc))));
    } else {
      this.dirty.forEach(r => { const row = this.rows[r - 1]; if (row) sql.exec("INSERT OR REPLACE INTO cells (sheet, r, data) VALUES (?, ?, ?)", this.name, r, JSON.stringify(row.map(enc))); });
    }
    this.dirty.clear(); this.full = false;
  }
}
const BOOK = {
  getSheetByName(name) {
    if (DB.sheets.has(name)) return DB.sheets.get(name);
    const known = DB.sql.exec("SELECT name FROM sheets WHERE name = ?", name).toArray();
    if (!known.length) return null;
    const rows = []; for (const x of DB.sql.exec("SELECT r, data FROM cells WHERE sheet = ? ORDER BY r", name)) rows[x.r - 1] = JSON.parse(x.data).map(dec);
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    const sh = new Sheet(name, rows); DB.sheets.set(name, sh); return sh;
  },
  insertSheet(name) { DB.sql.exec("INSERT OR IGNORE INTO sheets (name) VALUES (?)", name); const sh = new Sheet(name, []); DB.sheets.set(name, sh); return sh; },
};
const SpreadsheetApp = { openById: () => BOOK };

// ── 캐시 흉내: 메모리 + SQLite (잠들었다 깨어나도 유지) ──
function kv_() {
  if (!DB.kv) { DB.kv = new Map(); const now = Date.now(); for (const x of DB.sql.exec("SELECT k, v, exp FROM kv")) if (x.exp > now) DB.kv.set(x.k, { v: x.v, exp: x.exp }); }
  return DB.kv;
}
const CACHE = {
  get(k) { const e = kv_().get(k); if (!e) return null; if (e.exp <= Date.now()) { kv_().delete(k); DB.kvDirty.add(k); return null; } return e.v; },
  put(k, v, ttl) { kv_().set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }); DB.kvDirty.add(k); if (k === "live" || k === "watchers" || k.startsWith("chat_") || k === "rooms") DB.ping = true; },
  remove(k) { kv_().delete(k); DB.kvDirty.add(k); if (k.startsWith("chat_") || k === "rooms") DB.ping = true; },
  getAll(keys) { const o = {}; keys.forEach(k => { const v = CACHE.get(k); if (v != null) o[k] = v; }); return o; },
  putAll(obj, ttl) { Object.keys(obj).forEach(k => CACHE.put(k, obj[k], ttl)); },
};
const CacheService = { getScriptCache: () => CACHE };
// Durable Object 는 한 번에 요청 하나씩 처리하므로 잠금이 필요 없습니다
const LockService = { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) };
const ScriptApp = { getService: () => ({ getUrl: () => SITE_URL }) };
const DriveApp = { getFolderById() { throw new Error("드라이브 없음"); } };

// ── SHA-256 (구글 Utilities.computeDigest 와 같은 결과) ──
function sha256Bytes(str) {
  const msg = new TextEncoder().encode(str), K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, buf = new Uint8Array(nb); buf.set(msg); buf[l] = 0x80;
  const bits = l * 8, dv = new DataView(buf.buffer); dv.setUint32(nb - 4, bits >>> 0); dv.setUint32(nb - 8, Math.floor(bits / 4294967296));
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < nb; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const s0 = rotr(W[i-15],7) ^ rotr(W[i-15],18) ^ (W[i-15] >>> 3), s1 = rotr(W[i-2],17) ^ rotr(W[i-2],19) ^ (W[i-2] >>> 10); W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) { const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + W[i]) >>> 0, S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) >>> 0; h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = []; H.forEach(x => out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255)); return out;
}
const Utilities = {
  DigestAlgorithm: { SHA_256: "SHA_256" },
  // 구글 서버는 문자열의 한글 등 비ASCII 글자를 '?' 로 바꿔 계산했습니다. 기존 비밀번호와 맞추려고 똑같이 합니다
  computeDigest: (alg, s) => sha256Bytes(String(s).replace(/[^\x00-\x7f]/g, '?')),
  base64Encode: b => { const a = typeof b === "string" ? Array.from(new TextEncoder().encode(b)) : b; let s = ""; a.forEach(x => s += String.fromCharCode(x & 255)); return btoa(s); },
  getUuid: () => crypto.randomUUID(),
  formatDate(d, tz, f) {   // 이 게임은 한국 시간만 씁니다
    const k = new Date(new Date(d).getTime() + 9 * 3600 * 1000), p = n => String(n).padStart(2, "0");
    return f.replace("yyyy", k.getUTCFullYear()).replace("MM", p(k.getUTCMonth() + 1)).replace("dd", p(k.getUTCDate())).replace("HH", p(k.getUTCHours())).replace("mm", p(k.getUTCMinutes())).replace("ss", p(k.getUTCSeconds()));
  },
};
const HtmlService = {}, ContentService = {};

// ════════════════ 게임 코드 (Code.gs) ════════════════
/**
 * 검키우기 대장간 — 서버 (Google Apps Script)
 * 데이터는 아래 SHEET_ID 의 구글 시트(내 드라이브 「검키우기 이미지」 폴더 안 「검키우기 데이터」)에 저장됩니다.
 * 강화·판매·배틀의 확률 계산은 모두 여기서 하므로 플레이어가 화면을 조작해도 결과를 바꿀 수 없습니다.
 * 나중에 앱이나 카카오톡 챗봇을 붙일 때는 doPost(JSON) 로 같은 기능을 부르면 됩니다.
 */
const SHEET_ID = '1LNhPJ-dtD1d8i7sEEswVb8BmnUVgGFKd4RwZTxQNOF4';
const PUBLIC_MIN = 12, HIGH_LV = 15;
const MAX = 20, BASE = '녹슨 부지깽이', HIDDEN_EACH = 1, START_GOLD = 100000;
const AID_GOLD = 100000, AID_PER_DAY = 3, BATTLE_PER_DAY = 10, STATE_VER = 2;
const ODDS = [[100,0],[89,0],[79,0],[69,0],[62,4],[50,10],[45,10],[36,10],[29,10],[21,10],[19,10],[14,9],[10,5],[14,5],[11,11],[5,8],[7,7],[8,8],[10,11],[10,11]];   // ODDS[l] = +l 에서 +(l+1) 로 갈 때 [성공%, 파괴%]
const LINES=[
{n:"강철",h:0,s:"쇠붙이 검|무딘 철검|벼린 철검|단단한 철검|날 선 철검|병사의 철검|백인장 철검|기사의 강철검|정예 강철검|명장의 강철검|백련 강철검|천련 강철검|무쇠 왕의 검|강철 군주검|불굴의 강철검|철혈 대검|만근 철혈검|강철 제왕검|불멸의 철혈검|신철 천왕검"},
{n:"화염",h:0,s:"불씨 검|잔불 검|모닥불 검|화로의 검|불꽃 검|화염검|열화검|홍련검|업화검|용암검|화산검|태양 불꽃검|불사조 검|겁화검|지옥불 검|화신의 검|염제검|태양신의 검|천지 겁화검|원초의 불꽃검"},
{n:"얼음",h:0,s:"서리 검|살얼음 검|고드름 검|얼음검|빙결검|설한검|눈보라 검|빙하검|만년설 검|혹한검|빙룡검|극한 빙결검|절대영도 검|빙설 여왕검|동토의 검|빙하기의 검|빙신검|영겁 빙결검|설원 제왕검|태초의 얼음검"},
{n:"번개",h:0,s:"정전기 검|불티 검|전류 검|번갯불 검|뇌전검|벼락검|천둥검|뇌광검|뇌우검|폭뢰검|뇌룡검|천뢰검|뇌신의 검|만뢰검|뇌제검|천둥 군주검|구천뇌검|뇌정 파천검|천벌의 뇌검|창세 뇌신검"},
{n:"바람",h:0,s:"산들 검|미풍 검|솔바람 검|돌개바람 검|질풍검|선풍검|회오리 검|폭풍검|태풍검|광풍검|열풍검|풍룡검|천풍검|풍신의 검|폭풍 군주검|대폭풍 검|하늘 가르는 검|천공 풍제검|만풍 지배검|태초의 바람검"},
{n:"바다",h:0,s:"물방울 검|이슬 검|시냇물 검|강물 검|급류검|파도검|해류검|해일검|심해검|청해검|해룡검|대해검|해왕검|해신의 검|대해일 검|심연의 검|만경창파 검|칠해 제왕검|해황 천벌검|태초의 바다검"},
{n:"대지",h:0,s:"돌멩이 검|자갈 검|바위 검|화강암 검|암석검|대지검|지진검|산악검|태산검|철벽 암검|지룡검|대륙검|지맥검|대지 분노검|산맥 가르는 검|지신의 검|태산 붕괴검|대륙 제왕검|천지개벽 검|태초의 대지검"},
{n:"빛",h:0,s:"촛불 검|등불 검|햇살 검|빛의 검|광명검|섬광검|성광검|백광검|광휘검|천광검|성스러운 검|태양검|빛의 성검|대천사의 검|신성 광휘검|광명 군주검|천상의 성검|만광 심판검|창세의 빛검|절대 광명검"},
{n:"어둠",h:0,s:"그늘 검|그림자 검|땅거미 검|어둠의 검|흑암검|암흑검|칠흑검|야천검|흑염검|심야검|암흑 기사검|그림자 군주검|흑룡검|마왕의 검|암흑 제왕검|영원한 밤검|공허의 검|심연 지배검|절대 암흑검|종말의 어둠검"},
{n:"맹독",h:0,s:"풀독 검|벌침 검|거미독 검|전갈 검|독사 검|맹독검|살모사 검|코브라 검|독안개 검|역병검|부식검|독룡검|천독검|만독검|독왕의 검|독황검|만독 불사검|역병 군주검|천하 독제검|태초의 맹독검"},
{n:"혈검",h:0,s:"핏방울 검|생채기 검|핏빛 검|혈흔검|선혈검|혈도검|흡혈검|혈월검|혈풍검|혈룡검|혈해검|혈귀검|피의 군주검|혈마검|만혈검|혈왕검|혈천검|혈신의 검|불멸 흡혈검|태초의 혈검"},
{n:"용",h:0,s:"도마뱀 검|이무기 검|새끼용 검|비룡검|청룡검|적룡검|흑룡 비늘검|용아검|용린검|용혈검|용왕검|고룡검|천룡검|용신검|만룡검|용황검|용제검|진룡 천왕검|용신 제왕검|태초의 용검"},
{n:"우주",h:0,s:"반딧불 검|샛별 검|별빛 검|유성검|혜성검|성운검|은하검|성좌검|북극성 검|초신성 검|우주검|성간검|성신의 검|은하 제왕검|블랙홀 검|성계 지배검|천체 붕괴검|만성 제왕검|우주 창조검|빅뱅의 검"},
{n:"달",h:0,s:"초승달 검|반달 검|보름달 검|월광검|월영검|은월검|청월검|만월검|월하검|월식검|월광 기사검|월궁검|천월검|월신검|월야 군주검|월령 제왕검|만월 심판검|천상 월황검|영원한 달검|태초의 달검"},
{n:"해적",h:0,s:"녹슨 갈고리검|갑판 청소검|선원의 단검|갑판장 검|항해사 검|해적 곡도|해적 단검|해적 장검|일등항해사 검|해적 선장검|흑기 선장검|바다 약탈검|유령선 검|해적왕의 검|칠해 약탈검|크라켄 사냥검|해적 황제검|저주받은 해적검|전설의 해적왕검|해적신의 검"},
{n:"무림",h:0,s:"나무 목검|대나무 죽검|수련생 목검|초보 무사검|낭인의 칼|떠돌이 협객검|협객의 장검|검객의 애검|무림 고수검|절정 고수검|일대 종사검|검왕의 검|검성의 검|검선의 검|검황의 검|천하제일검|검신의 검|무림 지존검|검도 극의검|무극 검신검"},
{n:"마법",h:0,s:"견습 마법검|룬 새긴 검|마나 검|비전검|주문검|마법사의 검|마력검|룬 기사검|대마법사 검|원소검|비전 군주검|현자의 검|마도검|대현자의 검|마도왕의 검|금단의 마검|마신의 검|아카식 검|만법 지배검|태초의 마법검"},
{n:"황제",h:0,s:"종자의 검|견습 기사검|기사의 검|근위 기사검|기사단 검|기사단장 검|성기사 검|백작의 검|후작의 검|공작의 검|왕자의 검|국왕의 검|대왕의 검|황태자 검|황제의 검|대제국 검|천하 황제검|만국 황제검|세계 정복검|태초 황제검"},
{n:"저주",h:0,s:"금 간 검|불길한 검|저주받은 검|원혼검|원한의 검|망령검|요검|흉검|마검|귀검|사령검|사신의 검|죽음의 낫검|흑마검|지옥검|마계검|절망의 검|파멸의 검|멸망의 마검|종말 사신검"},
{n:"숲",h:0,s:"나뭇가지 검|회초리 검|대나무 검|참나무 검|박달나무 검|가시덩굴 검|숲지기 검|엘프의 검|고목검|정령목 검|숲의 군주검|천년목 검|만년목 검|신목검|숲의 여왕검|대자연 검|세계수 검|생명의 검|만물 생장검|태초의 숲검"},
{n:"꽃",h:0,s:"들꽃 검|민들레 검|진달래 검|장미 검|가시장미 검|백합검|모란검|연꽃검|매화검|벚꽃검|흑장미 검|월하미인 검|천화검|화왕검|만개검|꽃의 여왕검|천상화 검|만화 군주검|영원의 꽃검|태초의 꽃검"},
{n:"보석",h:0,s:"동전 검|구리 검|청동 검|은검|백은검|황금검|순금검|백금검|호박 검|자수정 검|에메랄드 검|사파이어 검|루비 검|다이아 검|금강석 검|오리하르콘 검|미스릴 검|아다만 검|현자의 돌검|무한 보석검"},
{n:"부엌",h:0,s:"버터 나이프|과도|식칼|중식도|회칼|사시미 장인검|정육점 큰칼|궁중 수라검|요리왕 식칼|미슐랭 셰프검|삼스타 셰프검|요리신의 칼|만한전석 칼|천상 요리검|전설의 식칼|요리 제왕검|미각 지배검|만찬의 신검|우주 셰프검|태초의 식칼"},
{n:"농기구",h:0,s:"호미|낫|쇠스랑|괭이|농부의 낫|추수 낫|대낫|풍년 대낫|논두렁 대검|황금 들녘검|대지주의 검|곡창 지배검|풍년신 대낫|농신의 낫|만석지기 검|천하 농군검|추수 군주검|대풍작 신검|오곡 제왕검|태초의 농검"},
{n:"문방구",h:0,s:"연필 검|볼펜 검|자 검|커터칼|가위검|삼각자 검|각도기 검|컴퍼스 검|만년필 검|붓 검|명필의 붓검|학자의 검|선비의 검|대학자 검|문필 군주검|글의 신검|만권 독파검|천하 문장검|문신의 검|태초의 붓검"},
{n:"음악",h:0,s:"리코더 검|하모니카 검|기타줄 검|바이올린 활검|첼로 활검|지휘봉 검|가야금 검|거문고 검|교향곡 검|악성의 검|협주곡 검|광시곡 검|천상 선율검|음악신의 검|화음 군주검|만악 지배검|천둥 교향검|우주 화음검|영원의 선율검|태초의 음검"},
{n:"게임",h:0,s:"1비트 검|8비트 검|16비트 검|도트 검|픽셀 검|레트로 검|아케이드 검|콤보 검|보스 검|레어 검|에픽 검|유니크 검|레전드 검|신화 검|만렙 검|치트키 검|버그 검|운영자 검|개발자 검|창조주 검"},
{n:"기계",h:0,s:"고철 검|볼트 검|톱니 검|모터 검|전기톱 검|드릴 검|레이저 검|플라즈마 검|광선검|나노 검|사이버 검|메카 검|로봇 군단검|양자검|중력검|반물질 검|AI 군주검|초공간 검|특이점 검|오메가 검"},
{n:"사막",h:0,s:"모래알 검|모래 검|신기루 검|선인장 검|사막여우 검|모래폭풍 검|열사검|사막검|전갈왕 검|오아시스 검|사구검|모래 군주검|피라미드 검|파라오의 검|태양 사막검|사막 제왕검|열사의 왕검|만리 사막검|모래신의 검|태초의 사막검"},
{n:"호랑이",h:0,s:"줄무늬 검|새끼범 검|살쾡이 검|표범 검|범 발톱검|호랑이 검|백호검|맹호검|산군의 검|호랑이 왕검|백두산 호검|호왕검|백호 군주검|천호검|만호검|호신의 검|백호 제왕검|산중 호황검|천하 맹호검|태초의 백호검"},
{n:"늑대",h:0,s:"코요테 검|여우 검|늑대 이빨검|회색늑대 검|은랑검|흑랑검|광랑검|늑대 무리검|우두머리 검|늑대왕 검|월랑검|천랑검|설원 늑대검|펜리르 검|늑대신의 검|만랑 군주검|천랑성 검|은월 낭왕검|늑대 제왕검|태초의 늑대검"},
{n:"날개",h:0,s:"깃털 검|참새 검|까치 검|매 검|송골매 검|수리 검|독수리 검|검독수리 검|하늘매 검|붕새 검|천응검|뇌조검|봉황검|대붕검|천조검|창공 군주검|하늘의 왕검|봉황 제왕검|만조 지배검|태초의 날개검"},
{n:"백골",h:0,s:"닭뼈 검|생선뼈 검|짐승뼈 검|해골 검|백골검|해골 기사검|뼈 군단검|해골 장군검|리치의 검|본드래곤 검|명계검|해골왕 검|백골 대군검|사령왕 검|망자 군주검|명왕검|저승 판관검|명부 제왕검|불사 군주검|태초의 백골검"},
{n:"수정",h:0,s:"유리조각 검|유리 검|강화유리 검|거울 검|크리스탈 검|수정검|프리즘 검|무지개 검|투명검|환영검|수정 기사검|수정궁 검|만화경 검|수정 군주검|천수정 검|빛굴절 검|차원 거울검|수정 제왕검|무한 반사검|태초의 수정검"},
{n:"시간",h:0,s:"초침 검|분침 검|시침 검|모래시계 검|태엽 검|시계탑 검|찰나검|순간검|과거의 검|미래의 검|시공검|차원검|시간 정지검|윤회의 검|영겁검|시간 군주검|차원 붕괴검|시공 지배검|무한 시간검|태초의 시간검"},
{n:"총",h:1,s:"물총|고무줄총|새총|비비탄총|에어건|권총|리볼버|산탄총|소총|저격총|기관단총|기관총|개틀링건|레일건|레이저건|플라즈마건|입자포|궤도 포격총|행성 파괴포|우주 섬멸포"},
{n:"칫솔",h:1,s:"몽당 칫솔|아기 칫솔|대나무 칫솔|보통 칫솔|부드러운 칫솔|미세모 칫솔|치간 칫솔|전동 칫솔|음파 칫솔|치과의사 칫솔|황금 칫솔|다이아 칫솔|충치 퇴치솔|치석 파괴솔|잇몸 수호솔|무결점 미소솔|백옥 치아솔|치아 요정솔|덴탈 군주솔|전설의 칫솔"},
{n:"강아지",h:1,s:"꼬질 강아지|아기 강아지|솜뭉치 강아지|산책 강아지|똑똑한 강아지|진돗개|풍산개|셰퍼드|경찰견|군견|명견|늑대개|대형견 대장|지옥 수문견|천상 수호견|달려라 신견|별을 무는 개|댕댕 군주|우주 최강 댕댕|전설의 멍멍이"},
{n:"고양이",h:1,s:"길고양이|아기 고양이|솜털 고양이|식빵 굽는 냥|사냥냥이|치즈냥이|턱시도 냥이|삵|스라소니|표범냥|흑표범냥|사자냥|백사자냥|냥냥 장군|고양이 대왕|냥이 군주|달빛 요괴냥|천상 냥신|우주 냥제|태초의 냥이"},
{n:"젓가락",h:1,s:"나무젓가락|일회용 젓가락|대나무 젓가락|쇠젓가락|스텐 젓가락|옻칠 젓가락|은젓가락|금젓가락|자개 젓가락|궁중 젓가락|수라간 젓가락|임금님 젓가락|용 새긴 젓가락|젓가락 달인|젓가락 쌍검|무림 쌍젓가락|젓가락 검성|천하 쌍젓신|우주 젓가락|태초의 젓가락"},
{n:"우진",h:1,s:"넌 나가라 우진|터져서 없어진 우진|다시 붙인 우진|엉엉슨한 우진|슬슬 부푼 우진|빵빵한 우진|터질듯한 우진|겁나게 큰 김우진|빅 S 우진|개꿀 쌉야르인 우진|쌉가능 우진|킹받는 우진|킹갓제너럴 우진|우진 그 자체|쌉고수 김우진|개쩌는 빅 우진|레전드 오브 우진|우진 is 뭔들|넌 들어와라 우진|우주 대폭발 우진"}
].map(l=>({n:l.n,h:!!l.h,names:l.s.split("|")}));
const BASE_DESC = "아궁이 뒤적이던 막대기. 그래도 꿈은 크다.";
const DESC = {"강철": ["고물상 아저씨도 안 받아 준 쇳조각", "종이도 겨우 자른다. 가끔은 못 자른다", "대장장이가 한숨 쉬며 열 번 두드렸다", "휘어지진 않는다. 장점은 그게 전부", "드디어 사과를 깎을 수 있게 됐다", "보급품 도장이 아직 선명하다", "부하 백 명이 부러워하는 검", "가문 문장을 새겼는데 조금 삐뚤다", "열병식 때만 꺼내는 귀한 몸", "명장이 직접 사인까지 해 줬다", "백 번 접었다. 접을 때마다 욕도 했다", "천 번 접었더니 대장장이 팔이 접혔다", "무쇠 왕이 잘 때도 끌어안고 잤다", "녹슬 틈을 주지 않는 성실한 군주", "백 번 부러져도 백한 번 일어선다", "들기만 해도 근육이 자란다", "무게 만 근. 들고 다니는 게 곧 수련", "모든 쇠붙이가 고개를 숙인다", "녹스는 법을 아예 잊어버렸다", "하늘의 쇠로 벼린 강철의 끝"], "화염": ["입으로 불면 꺼질 것 같다", "고구마 굽기 딱 좋은 온도", "캠핑장 인기 1위", "할머니 화로에서 갓 꺼냈다", "휘두르면 탁탁 불꽃이 튄다", "이제 진짜 뜨겁다. 장갑 필수", "칼집이 자꾸 탄다", "붉은 연꽃처럼 활활 핀다", "업보까지 태워 버리는 불길", "칼끝에서 용암이 뚝뚝 떨어진다", "휘두를 때마다 작은 분화구가 생긴다", "한낮의 태양을 칼날에 가뒀다", "부러져도 재에서 다시 태어난다", "세상 끝에 타오른다는 그 불", "지옥 소방서가 출동을 포기했다", "불의 신이 직접 쓰던 물건", "불꽃의 황제. 라이터 따위 필요 없다", "태양신이 잃어버린 개인 소지품", "하늘과 땅을 동시에 태운다", "세상에 처음 붙은 그 불씨"], "얼음": ["창문에 낀 서리 정도의 위력", "밟으면 쩍 갈라질 것 같다", "처마 끝에서 막 따 왔다", "여름엔 냉장고에 보관하세요", "닿는 순간 얼어붙는다", "손잡이를 잡으면 손이 시리다", "휘두르면 눈보라가 따라온다", "빙하 한 조각을 통째로 깎았다", "만 년 동안 녹지 않았다", "영하 50도. 숨 쉬면 입김이 언다", "얼음 용의 비늘로 빚었다", "베인 자리가 그대로 조각상이 된다", "원자도 멈추는 온도", "겨울 왕국의 여왕이 아끼던 검", "동토에 꽂아 두면 봄이 안 온다", "휘두르면 빙하기가 다시 온다", "얼음 신의 손에서 내려왔다", "영원히 녹지 않는 겨울", "설원의 모든 눈이 이 검을 따른다", "세상 첫눈으로 빚은 칼"], "번개": ["스웨터 벗을 때 찌릿 정도", "불티가 튀긴 하는데 따끔하지는 않다", "건전지 몇 개 분량의 전기", "번쩍하긴 한다. 소리는 아직 없다", "손잡이에 고무를 꼭 감으세요", "맑은 날에도 벼락이 떨어진다", "휘두르면 우르릉 소리가 난다", "칼날이 번개처럼 번쩍인다", "늘 먹구름을 데리고 다닌다", "번개 여러 개가 한꺼번에 터진다", "번개 용이 칼날에 깃들었다", "하늘의 벼락을 그대로 담았다", "뇌신이 쓰다 놓고 간 검", "만 개의 번개가 동시에 친다", "번개의 황제. 정전은 이 검 탓", "천둥을 부하처럼 부린다", "아홉 하늘의 번개를 모았다", "하늘을 쪼개는 일격", "나쁜 놈에게만 떨어지는 번개", "세상을 처음 밝힌 번개"], "바람": ["머리카락이 살짝 날린다", "부채질용으로 인기가 많다", "소나무 사이로 솔솔 분다", "낙엽을 빙글빙글 돌린다", "바람처럼 빠르게 벤다", "휘두르면 회오리가 인다", "동네 쓰레기통이 날아갔다", "폭풍 주의보를 몰고 다닌다", "태풍 이름을 하나 받았다", "미친 듯이 불어 닥친다", "뜨거운 사막 바람을 품었다", "바람의 용이 칼날을 감쌌다", "하늘의 바람을 마음대로 부린다", "바람 신이 아끼던 부채 대신 쓴 검", "폭풍을 부하로 거느린다", "대륙 하나를 쓸어버리는 바람", "휘두르면 하늘이 둘로 갈라진다", "하늘 높은 곳의 바람을 지배한다", "세상 모든 바람이 이 검을 따른다", "세상에 처음 분 바람"], "바다": ["이슬보다 조금 크다", "아침 풀잎에서 모았다", "졸졸 흐르는 소리가 들린다", "강물처럼 유유히 벤다", "휩쓸리면 답이 없다", "휘두르면 철썩 소리가 난다", "해류를 타고 어디든 간다", "휘두르면 해안가가 대피한다", "깊은 바다의 압력을 품었다", "맑고 푸른 바다의 검", "바다 용이 칼날에 깃들었다", "대양 하나를 통째로 담았다", "바다의 왕이 쓰던 검", "바다의 신이 삼지창 대신 골랐다", "대륙을 덮칠 해일을 부른다", "끝없는 심연을 들여다봤다", "만 리에 펼쳐진 파도", "일곱 바다의 제왕", "바다가 내리는 벌", "세상 첫 바다에서 건졌다"], "대지": ["길가에서 주웠다. 그냥 돌이다", "자갈 몇 개를 붙였다", "무겁다. 일단 무겁다", "묘비로도 쓸 수 있을 만큼 단단하다", "단단하고 묵직한 바위 검", "꽂으면 땅이 살짝 흔들린다", "휘두르면 진도 3의 지진", "산 하나를 깎아 만들었다", "태산처럼 꿈쩍도 않는다", "어떤 공격도 튕겨 낸다", "땅속 용이 잠에서 깼다", "대륙의 기운을 담았다", "땅의 핏줄과 이어졌다", "대지가 화나면 이렇게 된다", "휘두르면 산맥이 둘로 갈라진다", "땅의 신이 내려 준 검", "태산도 무너뜨린다", "모든 대륙이 고개를 숙인다", "하늘과 땅이 새로 열린다", "세상 첫 땅에서 캐냈다"], "빛": ["바람 불면 꺼진다. 조심", "밤길 산책용으로 딱 좋다", "아침 햇살처럼 따뜻하다", "어둠 속에서도 반짝인다", "밝고 바른 빛의 검", "번쩍하면 눈이 부시다", "별빛처럼 성스럽다", "하얗게 빛나는 칼날", "찬란한 광채가 흘러나온다", "하늘의 빛을 내려받았다", "보기만 해도 마음이 정화된다", "한낮의 태양을 담았다", "빛의 기사가 들던 성검", "대천사가 잠깐 빌려줬다", "신성한 빛이 넘쳐흐른다", "모든 빛을 다스린다", "하늘나라 무기고 1번 칸", "만 갈래 빛으로 심판한다", "세상을 처음 밝힌 빛", "어둠이 감히 다가오지 못한다"], "어둠": ["나무 그늘 정도의 어둠", "그림자처럼 살금살금", "해 질 녘에만 힘이 난다", "어둠 속에서 더 잘 보인다", "검은 기운이 스며 나온다", "빛을 빨아들인다", "새까매서 칼날이 안 보인다", "밤하늘을 칼날에 담았다", "검은 불꽃이 타오른다", "한밤중에 가장 강해진다", "어둠의 기사가 들던 검", "그림자들이 고개를 숙인다", "검은 용의 이빨로 만들었다", "마왕이 애지중지하던 검", "어둠의 황제가 쓰던 검", "아침이 영원히 오지 않는다", "모든 것을 삼키는 공허", "심연이 이 검을 따른다", "빛 한 점 없는 완벽한 어둠", "세상의 끝에 내려앉는 어둠"], "맹독": ["옻나무 정도의 독. 가렵다", "벌에 쏘인 만큼 따끔하다", "거미줄이 칼날에 붙어 있다", "꼬리에 독침이 달렸다", "독사의 이빨을 박아 넣었다", "칼집에서 독이 뚝뚝 샌다", "한 번 물면 놓지 않는다", "고개를 쳐들고 위협한다", "독안개가 칼날을 감싼다", "휘두르면 마을에 역병이 돈다", "닿는 것마다 녹아내린다", "독룡의 독니로 만들었다", "하늘도 중독시키는 독", "만 가지 독을 모았다", "독의 왕이 쓰던 검", "독의 황제. 해독제가 없다", "만 가지 독에도 죽지 않는다", "역병을 부하로 거느린다", "천하의 모든 독을 다스린다", "세상에 처음 생긴 독"], "혈검": ["손가락 베인 정도의 피", "생채기 하나에도 엄살이 심하다", "칼날이 붉게 물들었다", "지워지지 않는 핏자국", "갓 흘린 붉은 피의 검", "피 홈이 깊게 파였다", "피를 마시고 강해진다", "붉은 달이 뜨면 깨어난다", "피바람을 몰고 온다", "피의 용이 깃들었다", "피의 바다를 건너왔다", "피에 굶주린 귀신이 붙었다", "피의 군주가 들던 검", "피의 마왕이 쓰던 검", "만 명의 피를 마셨다", "피의 왕국을 다스린다", "하늘까지 붉게 물든다", "피의 신이 내려 준 검", "영원히 죽지 않는 흡혈귀의 검", "세상 첫 피로 벼렸다"], "용": ["도마뱀 꼬리. 잘려도 또 자란다", "용이 되고 싶은 이무기", "갓 깨어난 아기 용의 이빨", "하늘을 나는 용의 날개", "푸른 용이 동쪽을 지킨다", "붉은 용의 숨결을 품었다", "검은 용의 비늘로 만들었다", "용의 송곳니를 깎았다", "용의 비늘이 촘촘하다", "용의 피로 담금질했다", "용왕님이 아끼던 검", "천 년을 산 늙은 용의 검", "하늘의 용이 내려 줬다", "용들이 신으로 모신다", "만 마리 용의 기운", "용의 황제가 쓰던 검", "용의 제왕. 모든 용이 엎드린다", "진짜 용이 깃든 왕의 검", "용신의 제왕이 쥐었던 검", "세상 첫 용의 이빨"], "우주": ["여름밤 개울가의 반딧불", "새벽에 가장 먼저 뜨는 별", "밤하늘 별빛을 담았다", "소원을 빌어도 된다", "꼬리를 길게 끌며 날아간다", "칼날 안에 성운이 소용돌이친다", "은하수가 칼날을 흐른다", "별자리가 새겨졌다", "길 잃은 사람을 인도한다", "별이 폭발하는 순간을 담았다", "우주 하나를 통째로 담았다", "별과 별 사이를 가른다", "별의 신이 쓰던 검", "은하의 제왕", "모든 것을 빨아들인다. 빛까지", "별의 세계를 다스린다", "휘두르면 행성이 부서진다", "만 개의 별을 거느린다", "새 우주를 만든다", "모든 것의 시작, 대폭발"], "달": ["가느다란 손톱달", "반만 빛난다. 나머지는 쉬는 중", "둥근 보름달이 떴다", "달빛을 칼날에 모았다", "달그림자 속에 숨는다", "은은한 은빛 달의 검", "푸른 달이 뜨는 밤의 검", "가득 찬 달의 힘", "달빛 아래서 가장 강하다", "달이 가려지는 순간의 검", "달빛 기사가 들던 검", "달나라 궁전에 있던 검", "하늘의 달을 베어 냈다", "달의 신이 쓰던 검", "달밤의 군주", "달의 영혼을 다스린다", "보름달 아래 심판한다", "하늘 위 달의 황제", "영원히 지지 않는 달", "세상 첫 달빛"], "해적": ["녹슨 갈고리. 파상풍 주의", "갑판 닦는 막대에 날을 달았다", "신입 선원의 첫 단검", "갑판장의 잔소리가 깃들었다", "별을 보고 길을 찾는 항해사의 검", "휘어진 해적 칼", "이빨에 물고 다니는 단검", "진짜 해적처럼 보이기 시작했다", "선장 바로 아래의 검", "해적 선장의 자존심", "검은 깃발을 단 선장의 검", "바다를 털고 다닌다", "유령선에서 건졌다. 밤마다 운다", "해적왕이 숨겨 둔 보물", "일곱 바다를 털었다", "거대한 바다 괴물을 잡았다", "모든 해적을 거느린다", "저주받은 보물. 갖는 순간 후회한다", "전설로만 전해지던 해적왕의 검", "바다 사나이들이 기도하는 검"], "무림": ["수련생의 첫 나무 검", "대나무로 만든 연습용 검", "매일 천 번씩 휘둘렀다", "갓 하산한 초보 무사", "주인 없이 떠도는 칼", "의리 하나로 떠도는 협객", "약한 자를 돕는 칼", "검객이 목숨처럼 아낀다", "무림에 이름이 알려졌다", "고수 중의 고수", "한 문파를 세운 큰 스승의 검", "검의 왕", "검의 성인", "검의 신선. 구름 위를 걷는다", "검의 황제", "천하에 하나뿐인 검", "검의 신", "무림을 발아래 둔다", "검도의 끝에 닿았다", "끝이 없는 검의 신"], "마법": ["마법학교 1학년 실습용", "룬 문자를 하나 새겼다", "마나가 조금 흐른다", "비밀스러운 주문을 품었다", "휘두르면 주문이 나간다", "마법사가 지팡이 대신 들었다", "마력이 넘쳐흐른다", "룬 기사단의 검", "대마법사가 쓰던 검", "불·물·바람·흙을 모두 다룬다", "비전 마법의 군주", "현자가 깨달음을 얻은 검", "마도의 길을 걷는 자의 검", "대현자의 지혜가 담겼다", "마도의 왕이 쓰던 검", "쓰면 안 되는 금단의 검", "마법의 신이 쓰던 검", "세상 모든 지식이 담겼다", "모든 마법을 다스린다", "세상 첫 마법"], "황제": ["기사를 따라다니는 종자의 검", "견습 기사가 처음 받은 검", "정식 기사가 되었다", "왕을 지키는 근위 기사의 검", "기사단의 깃발을 달았다", "기사단장의 위엄", "신을 섬기는 성기사의 검", "백작님의 가보", "후작님의 가보", "공작님의 가보", "왕자님이 아끼는 검", "국왕의 검. 왕관과 세트", "대왕의 검", "다음 황제가 될 자의 검", "황제의 검", "대제국을 세운 검", "천하를 다스리는 황제의 검", "만 개 나라를 거느린다", "세계를 정복했다", "세상 첫 황제의 검"], "저주": ["금이 쩍 갔다. 조심해서 쓰자", "왠지 기분이 나쁘다", "저주가 걸렸다. 버려도 돌아온다", "억울한 영혼이 깃들었다", "원한이 쌓여 무거워졌다", "망령이 칼날에 붙어 산다", "요사스러운 기운이 흐른다", "불길한 기운이 뚝뚝 흐른다", "진짜 마검이 되었다", "귀신이 깃든 검", "죽은 자를 부린다", "저승사자가 쓰던 검", "칼날이 낫처럼 휘었다", "검은 마귀가 깃들었다", "지옥에서 올라왔다", "마계의 문을 연다", "희망을 지워 버린다", "모든 것을 파멸로 이끈다", "세상을 멸망시킨다", "종말을 부르는 사신의 검"], "숲": ["산책길에서 주운 나뭇가지", "엄마의 회초리. 보기만 해도 아프다", "대나무 숲에서 잘라 왔다", "단단한 참나무 검", "박달나무 방망이를 깎았다", "가시덩굴이 감겨 있다", "숲지기가 들던 검", "엘프가 만든 우아한 검", "오래된 나무의 기운", "정령이 사는 나무로 만들었다", "숲을 다스린다", "천 년 묵은 나무의 검", "만 년 묵은 나무의 검", "신이 깃든 나무의 검", "숲의 여왕이 쓰던 검", "대자연의 힘이 깃들었다", "세계를 받치는 나무의 가지", "생명을 낳는다", "만물을 자라게 한다", "세상 첫 숲의 나무"], "꽃": ["길가에 핀 들꽃 한 송이", "후 불면 씨앗이 날아간다", "봄 산에 핀 진달래", "붉은 장미 한 송이", "가시가 있어 더 아름답다", "순결한 흰 백합", "꽃 중의 꽃, 부귀영화", "진흙 속에서도 깨끗하게 핀다", "추위 속에 피는 매화", "휘두르면 벚꽃이 흩날린다", "위험한 매력의 검은 장미", "달밤에 한 번만 핀다", "하늘에서 피어난 꽃", "꽃의 왕", "활짝 피어 절정에 올랐다", "꽃의 여왕이 쓰던 검", "하늘나라 정원의 꽃", "모든 꽃을 다스린다", "영원히 지지 않는다", "세상 첫 꽃"], "보석": ["동전을 녹여서 만들었다", "구릿빛이 반짝인다", "고대 청동기 시대의 유물", "은으로 만들었다. 퇴마 가능", "하얗게 빛나는 은", "진짜 금! 깨물어 봐도 된다", "24K 순금", "백금으로 만들었다", "꿀 같은 빛깔의 호박", "보랏빛 자수정", "초록빛 에메랄드", "푸른 사파이어", "붉은 루비", "다이아몬드. 영원하다", "무엇으로도 깰 수 없다", "전설의 금속 오리하르콘", "가볍고 단단한 미스릴", "세상에서 가장 단단한 금속", "무엇이든 금으로 바꾼다", "끝없이 빛나는 보석"], "부엌": ["버터만 바를 수 있다. 빵 위에서는 최강", "사과 깎기 전문", "도마 위의 기본기", "중국집 주방장의 묵직한 칼", "회 뜨는 칼. 살짝 무섭다", "장인이 회를 뜰 때만 꺼낸다", "정육점 사장님의 큰 칼", "임금님 수라상을 차린 칼", "요리왕 대회 우승 칼", "별 하나 받은 셰프의 칼", "별 세 개 받은 셰프의 칼", "요리의 신이 쓰던 칼", "108가지 요리를 만든 칼", "하늘의 잔치를 차렸다", "전설의 식칼. 양파를 썰어도 울지 않는다", "요리계의 제왕", "한입에 모두를 감동시킨다", "신들의 만찬을 차렸다", "우주 최고의 셰프", "세상 첫 요리를 만든 칼"], "농기구": ["텃밭 김매기 필수품", "풀 베는 낫", "거름 뒤집는 쇠스랑", "밭 가는 괭이", "농부 아저씨의 손때가 묻었다", "가을걷이용 낫", "커다란 낫. 살짝 위협적이다", "풍년을 부르는 큰 낫", "논두렁의 지배자", "황금빛 들판을 벤다", "대지주가 아끼는 농기구", "곡식 창고를 지배한다", "풍년의 신이 쓰던 낫", "농사의 신", "곡식 만 섬을 거둔다", "천하의 농부들이 우러러본다", "가을걷이의 군주", "대풍년을 부른다", "다섯 곡식의 제왕", "세상 첫 농사에 쓴 낫"], "문방구": ["지우개 달린 연필. 실수해도 괜찮다", "똑딱 볼펜", "30cm 자. 손바닥 맞을 때 쓰던 그것", "드르륵 커터칼", "종이 자르기 달인", "수학 시간의 삼각자", "각도기로 정확하게 벤다", "원을 그리며 벤다", "고급 만년필", "붓 한 자루", "명필가의 붓", "학자의 붓", "선비의 기개", "큰 학자의 붓", "글로 세상을 다스린다", "글의 신", "책 만 권을 다 읽었다", "천하제일 명문장", "글을 짓는 신", "세상 첫 글자를 쓴 붓"], "음악": ["초등학교 음악 시간의 추억", "숨 쉬면 소리가 난다", "기타 줄로 벤다", "바이올린 활로 켜고 벤다", "묵직한 저음의 첼로 활", "지휘자의 지휘봉", "열두 줄 가야금", "여섯 줄 거문고", "교향곡 한 곡이 담겼다", "음악의 성인이 쓰던 검", "협주곡이 울린다", "열정적인 광시곡", "하늘의 선율", "음악의 신이 쓰던 검", "화음을 다스린다", "모든 음악을 다스린다", "천둥 같은 교향곡", "우주에 울려 퍼지는 화음", "영원히 끝나지 않는 노래", "세상 첫 소리"], "게임": ["0과 1로만 그렸다", "8비트 시절 감성", "16비트로 업그레이드", "도트로 찍었다", "픽셀 하나하나 장인 정신", "옛날 게임기 감성", "동전 넣고 하는 오락실 검", "연속 콤보 가능", "보스가 떨어뜨렸다", "파란색. 레어 아이템", "보라색. 에픽 아이템", "주황색. 유니크 아이템", "레전드 아이템", "신화 등급", "만렙 달성", "치트키를 썼다. 운영자 몰래", "버그로 얻었다. 조용히 쓰자", "운영자만 갖고 있다", "개발자가 만든 테스트용 검", "이 게임을 만든 창조주의 검"], "기계": ["고철 더미에서 조립했다", "볼트로 조였다", "톱니바퀴가 돌아간다", "모터를 달았다. 윙윙", "부릉부릉 전기톱", "드릴처럼 돌며 뚫는다", "레이저가 나온다", "플라즈마로 녹인다", "빛으로 된 칼날", "아주 작은 기계들이 모였다", "사이버 세계의 검", "거대 로봇이 쓰던 검", "로봇 군단을 이끈다", "양자 역학으로 벤다", "중력을 조종한다", "반물질로 만들었다. 위험", "인공지능이 다스린다", "초공간을 가른다", "기술의 특이점에 도달했다", "마지막이자 최강의 기계 검"], "사막": ["모래 한 알. 신발 속 그것", "모래로 뭉쳤다. 바람 불면 위험", "있는 듯 없는 듯한 신기루", "가시가 박혀 있다. 아야", "귀가 큰 사막여우", "휘두르면 모래 폭풍이 인다", "뜨거운 모래의 검", "끝없는 사막을 담았다", "전갈 왕의 독침", "사막의 쉼터", "모래 언덕을 넘는다", "모래를 다스린다", "피라미드 안에서 찾았다", "파라오의 무덤에서 나왔다", "사막의 태양을 담았다", "사막의 제왕", "뜨거운 모래의 왕", "만 리 사막을 건넜다", "모래의 신", "세상 첫 모래"], "호랑이": ["줄무늬만 호랑이", "아기 호랑이. 어흥 연습 중", "작고 날쌘 살쾡이", "날렵한 표범", "호랑이 발톱을 달았다", "진짜 호랑이의 검", "하얀 호랑이", "사나운 호랑이", "산의 왕", "호랑이 중의 왕", "백두산 호랑이", "호랑이들의 왕", "백호가 다스린다", "하늘의 호랑이", "만 마리 호랑이의 기운", "호랑이 신", "백호의 제왕", "산속의 황제", "천하의 맹호", "세상 첫 백호"], "늑대": ["사막의 코요테. 늑대인 척 중", "여우의 꾀가 담겼다", "늑대 이빨을 박았다", "회색 늑대", "은빛 늑대", "검은 늑대", "미쳐 날뛰는 늑대", "무리와 함께 싸운다", "무리의 우두머리", "늑대들의 왕", "달 보고 우는 늑대", "하늘의 늑대", "눈 덮인 땅의 늑대", "전설의 거대 늑대", "늑대 신", "만 마리 늑대의 군주", "하늘의 늑대 별", "은빛 달 아래 늑대 왕", "늑대의 제왕", "세상 첫 늑대"], "날개": ["깃털 하나. 간지럽다", "짹짹 참새", "반가운 손님 까치", "날카로운 매", "빠른 송골매", "수리가 노린다", "하늘의 사냥꾼 독수리", "검독수리의 발톱", "하늘을 나는 매", "구만 리를 나는 큰 새", "하늘의 매", "번개를 부르는 새", "봉황이 날아들었다", "거대한 붕새", "하늘의 새", "창공을 다스린다", "하늘의 왕", "봉황의 제왕", "모든 새를 다스린다", "세상 첫 날개"], "백골": ["치킨 먹고 남은 뼈", "생선 가시. 목에 걸리면 큰일", "짐승 뼈로 만들었다", "해골이 달렸다. 덜그럭", "하얀 뼈로 만든 검", "해골 기사의 검", "뼈로 된 군대를 부른다", "해골 장군의 검", "죽음을 다루는 마법사의 검", "뼈만 남은 용", "저승의 검", "해골 왕국의 왕", "백골 대군을 이끈다", "죽은 자의 왕", "망자들의 군주", "저승의 왕", "저승의 재판관", "저승 명부를 다스린다", "죽지 않는 자들의 군주", "세상 첫 뼈"], "수정": ["깨진 유리 조각. 맨손 금지", "투명한 유리 검", "잘 안 깨지는 강화유리", "비추면 내 얼굴이 보인다", "반짝이는 크리스탈", "맑은 수정", "빛을 일곱 색으로 나눈다", "휘두르면 무지개가 뜬다", "거의 안 보인다", "환영을 만든다", "수정 기사의 검", "수정 궁전에 있던 검", "돌릴 때마다 무늬가 바뀐다", "수정을 다스린다", "하늘의 수정", "빛을 마음대로 꺾는다", "다른 차원을 비춘다", "수정의 제왕", "끝없이 반사된다", "세상 첫 수정"], "시간": ["째깍째깍 초침", "분침. 조금 느리다", "시침. 아주 느리다", "모래가 다 떨어지면 끝", "태엽을 감아 움직인다", "시계탑의 검", "찰나의 순간을 벤다", "순간 이동", "과거로 간다", "미래를 본다", "시간과 공간을 가른다", "다른 차원으로 간다", "시간을 멈춘다", "돌고 도는 윤회", "끝없이 긴 시간", "시간을 다스린다", "차원을 무너뜨린다", "시공간의 지배자", "끝없는 시간", "시간이 시작된 순간"], "총": ["여름엔 이게 최강", "고무줄 하나로 쏜다", "고무줄 새총", "비비탄 장난감 총", "공기로 쏜다", "진짜 권총이 나왔다", "서부의 총잡이", "한 번에 여러 발", "군인의 소총", "멀리서 한 방에", "연사가 된다", "두두두두", "손잡이를 돌리면 쏟아진다", "전기로 쏘는 레일건", "레이저 빔", "플라즈마를 쏜다", "입자를 쏘는 대포", "우주 궤도에서 쏜다", "행성을 부순다", "우주를 지운다"], "칫솔": ["다 닳아서 털이 없다", "아기용 말랑 칫솔", "친환경 대나무 칫솔", "그냥 칫솔. 평범함이 매력", "잇몸에 착 감긴다", "털이 아주 가늘다", "이 사이를 공략한다", "위잉 전동 칫솔", "음파로 닦는다", "치과 선생님의 칫솔", "금으로 만든 칫솔", "다이아가 박힌 칫솔", "충치를 물리친다", "치석을 부순다", "잇몸을 지킨다", "완벽한 미소를 만든다", "하얀 이를 만든다", "이빨 요정이 쓰던 칫솔", "치아 세계의 군주", "전설의 칫솔. 치과가 문을 닫았다"], "강아지": ["꼬질꼬질. 목욕부터 하자", "낑낑 아기 강아지", "솜뭉치처럼 폭신하다", "산책 가자고 조른다", "앉아, 손 다 한다", "충직한 진돗개", "용맹한 풍산개", "늠름한 셰퍼드", "경찰견. 범인 다 잡는다", "군견. 훈장 받았다", "이름난 명견", "늑대 피가 섞였다", "대형견 무리의 대장", "지옥 문을 지키는 개", "하늘을 지키는 개", "하늘을 달리는 신령한 개", "별을 물어 온다", "댕댕이들의 군주", "우주에서 제일 센 댕댕이", "전설의 멍멍이. 간식 주면 다 해 준다"], "고양이": ["골목의 주인", "아기 고양이. 냥", "솜털이 보송보송", "식빵 자세로 쉬는 중", "사냥 본능이 깨어났다", "노란 치즈 고양이", "턱시도 입은 신사 고양이", "야생 살쾡이", "귀 끝이 뾰족한 스라소니", "표범이 된 고양이", "검은 표범이 된 고양이", "사자가 된 고양이", "하얀 사자가 된 고양이", "냥이 군대의 장군", "고양이들의 대왕", "모든 냥이의 군주", "달밤의 요괴 고양이", "하늘의 고양이 신", "우주의 고양이 황제", "세상 첫 고양이. 다들 집사가 된다"], "젓가락": ["짝이 안 맞는다", "짜장면 먹고 나왔다", "대나무로 만든 젓가락", "쇠젓가락. 콩 집기 어렵다", "스테인리스 젓가락", "옻칠한 고급 젓가락", "은젓가락. 독을 알아본다", "금젓가락", "자개를 박았다", "궁중 젓가락", "수라간 주방의 젓가락", "임금님이 쓰던 젓가락", "용을 새긴 젓가락", "젓가락으로 파리도 잡는다", "두 짝을 쌍검처럼 쓴다", "무림 고수의 쌍젓가락", "젓가락의 검성", "천하의 쌍젓가락 신", "우주에서 제일 긴 젓가락", "세상 첫 젓가락"], "우진": ["나가라고 했다. 진짜로", "너무 부풀어서 펑", "테이프로 대충 다시 붙였다", "엉엉 울고 있다. 달래 줘야 한다", "다시 조금씩 부풀고 있다", "빵빵하다. 손대면 위험", "곧 터진다. 모두 엎드려", "진짜 겁나게 크다. 성까지 붙었다", "빅 사이즈 S. 옷이 안 맞는다", "개꿀이다. 이유는 묻지 마라", "다 쌉가능", "보기만 해도 킹받는다", "킹이자 갓이자 제너럴", "더 설명이 필요 없다. 우진 그 자체", "김우진, 고수가 되었다", "개쩌는 빅 사이즈 우진", "전설이 된 우진", "우진이면 뭐든 된다", "나가라더니 다시 들어오래", "우주가 터졌다. 우진 때문에"]};
const NORMAL = LINES.map((l,i)=>i).filter(i=>!LINES[i].h), SECRET = LINES.map((l,i)=>i).filter(i=>LINES[i].h);
// 경제표: COST[l] = +l 에서 +(l+1) 로 올리는 강화 1회 비용, SELL_N/SELL_H[l] = +l 검 판매가(일반/히든)
const COST   = [0,10,20,50,100,200,500,1000,2000,5000,10000,20000,30000,50000,70000,100000,150000,200000,300000,500000];
const SELL_N = [0,10,30,100,250,650,1700,4500,10000,30000,76000,200000,400000,800000,1550000,3300000,6400000,15000000,35000000,100000000,370000000];
const SELL_H = [0,95,270,780,1650,3900,11000,25000,48000,130000,240000,640000,1200000,2200000,3100000,6550000,12000000,24000000,58000000,130000000,480000000];
const cost = l => COST[l];
const baseSell = l => SELL_N[l] || 0;
const isHidden = line => line!=null && line>=0 && LINES[line].h;
const sellOf = (l,line) => (isHidden(line) ? SELL_H[l] : SELL_N[l]) || 0;
const nameOf = (l,line) => (l===0||line==null||line<0) ? BASE : LINES[line].names[l-1];
const scrollPrice = l => Math.max(300, cost(l)*6);
const PROTECT_MAX = 15;   // +15 이상에서는 파괴 방지를 쓸 수 없음
const protectCost = st => Math.floor(sellOf(st.lv, st.line) / 4);
// 상성: 불>쇠>자연>땅>물>불, 빛과 어둠은 서로 상극(도전하는 쪽 유리), 기묘는 예측 불가
const TYPE_OF = {강철:'쇠',화염:'불',얼음:'물',번개:'불',바람:'자연',바다:'물',대지:'땅',빛:'빛',어둠:'어둠',맹독:'자연',혈검:'어둠',용:'불',우주:'빛',달:'빛',해적:'물',무림:'쇠',마법:'빛',황제:'쇠',저주:'어둠',숲:'자연',꽃:'자연',보석:'땅',부엌:'쇠',농기구:'땅',문방구:'자연',음악:'빛',게임:'쇠',기계:'쇠',사막:'땅',호랑이:'자연',늑대:'어둠',날개:'자연',백골:'어둠',수정:'땅',시간:'빛',총:'쇠',칫솔:'물',강아지:'땅',고양이:'불',젓가락:'자연',우진:'기묘'};
const BEATS = {불:['쇠'], 쇠:['자연'], 자연:['땅'], 땅:['물'], 물:['불'], 빛:['어둠'], 어둠:['빛']};
const typeOf = line => line == null || line < 0 ? '없음' : (TYPE_OF[LINES[line].n] || '없음');
function matchup_(a, b, roll) {   // 도전자 기준 +1 유리, -1 불리, 0 보통
  const ta = typeOf(a), tb = typeOf(b);
  if (ta === '기묘' || tb === '기묘') return roll ? (Math.random() < 0.5 ? 1 : -1) : null;
  if ((BEATS[ta] || []).indexOf(tb) >= 0) return 1;
  if ((BEATS[tb] || []).indexOf(ta) >= 0) return -1;
  return 0;
}
const MATCH_BONUS = 2;   // 상성 유리/불리 = 강화 단계 ±2 만큼
const winP = (me,op) => 1/(1+Math.pow(10,(op-me)/4));
const prize = op => Math.round(baseSell(Math.max(op,1))*0.25)+15;
const fee = op => Math.round(prize(op)*0.4);
const fmt = n => Number(n).toLocaleString('ko-KR');

// ── 웹 진입점 ──────────────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('검키우기 대장간')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
// 앱·챗봇용 JSON API: POST {"action":"enhance","token":"..."}
function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (err) {}
  const out = api(req.action, req);
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ── 시트 ──────────────────────────────────────────────────
const P_HEAD = ['id','nickname','pinHash','token','lv','best','line','gold','state','updated','status','role','intro','created'];
function book_() { return SpreadsheetApp.openById(SHEET_ID); }
function sheet_(name, head) {
  const b = book_(); let sh = b.getSheetByName(name);
  if (!sh) { sh = b.insertSheet(name); sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function players_() { return sheet_('players', P_HEAD); }
function feedSheet_() { return sheet_('feed', ['time','text']); }
function allRows_() {
  const sh = players_(), n = sh.getLastRow()-1;
  if (n < 1) return [];
  return sh.getRange(2,1,n,P_HEAD.length).getValues().map((r,i)=>({row:i+2, id:r[0], nickname:String(r[1]), pinHash:r[2], token:r[3], lv:+r[4], best:+r[5], line:r[6]===''?null:+r[6], gold:+r[7], state:r[8], status:r[10]||'ok', role:r[11]||'player', intro:String(r[12]||''), created:r[13]}));
}
function findBy_(key, val) { return allRows_().find(r => r[key] === val) || null; }
function save_(row, st) {
  st.updated = Date.now();
  players_().getRange(row.row, 5, 1, 6).setValues([[st.lv, st.best, st.line==null?'':st.line, st.gold, JSON.stringify(st), new Date()]]);
}
function feed_(text) {   // 소식은 한국 시간 자정마다 새로 시작
  const sh = feedSheet_();
  if (sh.getLastRow() >= 2) {
    const first = sh.getRange(2, 1).getValue();
    if (first && Utilities.formatDate(new Date(first), 'Asia/Seoul', 'yyyy-MM-dd') !== today_()) sh.deleteRows(2, sh.getLastRow() - 1);
  }
  sh.appendRow([new Date(), text]);
  if (sh.getLastRow() > 600) sh.deleteRows(2, 200);
}
// ── 설정 (시트 「settings」에서 바로 고칠 수 있음) ──────────
function settings_() {
  const c = CacheService.getScriptCache(), hit = c.get('settings');
  if (hit) return JSON.parse(hit);
  const sh = sheet_('settings', ['key','value','설명']);
  if (sh.getLastRow() < 2) {
    sh.getRange(2,1,3,3).setValues([
      ['invite_code', 'SWORD' + Math.floor(1000+Math.random()*9000), '친구에게 알려 줄 초대 코드. 바꾸면 이전 코드로는 가입 신청이 안 됩니다'],
      ['admin_code', 'ADMIN' + Utilities.getUuid().slice(0,6).toUpperCase(), '이 코드로 가입하면 관리자 계정이 됩니다. 남에게 알려 주지 마세요'],
      ['require_approval', 'TRUE', 'TRUE 면 관리자가 승인해야 플레이할 수 있습니다']]);
  }
  const o = {};
  sh.getRange(2,1,sh.getLastRow()-1,2).getValues().forEach(r => o[String(r[0]).trim()] = String(r[1]).trim());
  c.put('settings', JSON.stringify(o), 60);
  return o;
}
// ── 검 그림 (드라이브의 game_sprites*.json 묶음에서 계열별 5x4 스프라이트를 꺼냄) ──
const SPRITE_FOLDER = '1lV5C1k24uMQ6Xm4A5Ee90RCehQ4bDFg_';
const HD_GROUPS = [[0,8],[9,18],[19,26],[27,34],[35,40]];   // game_sprites_hd_N.json 에 든 계열 번호 범위
function sprite_(i) {
  if (!(i >= 0 && i < LINES.length)) return {ok:false, error:'잘못된 계열'};
  const c = CacheService.getScriptCache(), k = 'spr4_' + i;
  const n = +(c.get(k + '_n') || 0);
  if (n) {
    const keys = []; for (let j = 0; j < n; j++) keys.push(k + '_' + j);
    const got = c.getAll(keys);
    if (keys.every(x => got[x])) return {ok:true, line:i, b64:keys.map(x => got[x]).join('')};
  }
  const g = HD_GROUPS.findIndex(r => i >= r[0] && i <= r[1]);
  const it = DriveApp.getFolderById(SPRITE_FOLDER).getFilesByName('game_sprites_hd_' + (g + 1) + '.json');
  let best = null; while (it.hasNext()) { const f = it.next(); if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f; }
  if (!best) return {ok:false, error:'그림이 아직 없습니다'};
  const d = JSON.parse(best.getBlob().getDataAsString('UTF-8'))[String(i)];
  if (!d) return {ok:false, error:'그림이 아직 없습니다'};
  const b = d.b64, size = 95000, put = {};
  for (let j = 0; j * size < b.length; j++) put[k + '_' + j] = b.slice(j * size, (j + 1) * size);
  put[k + '_n'] = String(Object.keys(put).length);
  try { c.putAll(put, 21600); } catch (e) {}
  return {ok:true, line:i, b64:b};
}
// ── 전체 채팅 (최근 80개는 캐시, 기록은 시트 chat 탭) ──
// ── 채팅방 (전체 방 lobby + 유저가 만든 방, 비밀번호 선택) ──
const LOBBY = 'lobby', ROOM_MAX = 40;
function roomsSheet_() { return sheet_('rooms', ['id','name','ownerId','ownerNick','pwHash','created','last']); }
function roomsRead_() {
  const c = CacheService.getScriptCache(), v = c.get('rooms'); if (v) return JSON.parse(v);
  const sh = roomsSheet_(), n = sh.getLastRow() - 1;
  const list = n < 1 ? [] : sh.getRange(2, 1, n, 7).getValues().map(r => ({id:String(r[0]), name:String(r[1]), ownerId:String(r[2]), ownerNick:String(r[3]), pw:String(r[4]||''), created:+new Date(r[5]), last:+new Date(r[6]||r[5])}));
  c.put('rooms', JSON.stringify(list), 21600); return list;
}
function roomsWrite_(list) {
  const sh = roomsSheet_(); if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  if (list.length) sh.getRange(2, 1, list.length, 7).setValues(list.map(r => [r.id, r.name, r.ownerId, r.ownerNick, r.pw, new Date(r.created), new Date(r.last)]));
  CacheService.getScriptCache().put('rooms', JSON.stringify(list), 21600);
}
function roomHash_(id, pw) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'room:' + id + ':' + pw)); }
function roomAccess_(room, pw) {   // 들어갈 수 있으면 방 정보, 아니면 에러 문자열
  if (!room || room === LOBBY) return {id:LOBBY, name:'전체'};
  const r = roomsRead_().find(x => x.id === room); if (!r) return '없어진 방입니다';
  if (r.pw && r.pw !== roomHash_(r.id, String(pw||''))) return '비밀번호가 맞지 않습니다';
  return r;
}
function chatRead_(room) {
  room = room || LOBBY;
  const c = CacheService.getScriptCache(), v = c.get('chat_' + room);
  if (v) return JSON.parse(v);
  const sh = sheet_('chat', ['time','nick','text','sys','room']), n = sh.getLastRow() - 1;
  const rows = n < 1 ? [] : sh.getRange(Math.max(2, sh.getLastRow() - 499), 1, Math.min(500, n), 5).getValues().filter(r => (String(r[4]||'') || LOBBY) === room).slice(-50);
  const C = {seq: rows.length, msgs: rows.map((r, i) => ({seq: i + 1, nick: String(r[1]), text: String(r[2]), sys: !!r[3], ts: new Date(r[0]).getTime()}))};
  c.put('chat_' + room, JSON.stringify(C), 21600); return C;
}
function chatPush_(m, room) {
  room = room || LOBBY;
  const C = chatRead_(room); C.seq++; m.seq = C.seq; m.ts = Date.now(); C.msgs.push(m); if (C.msgs.length > 80) C.msgs = C.msgs.slice(-80);
  CacheService.getScriptCache().put('chat_' + room, JSON.stringify(C), 21600);
  try { const sh = sheet_('chat', ['time','nick','text','sys','room']); sh.appendRow([new Date(), m.nick || '', m.text, m.sys ? 1 : '', room === LOBBY ? '' : room]); if (sh.getLastRow() > 1000) sh.deleteRows(2, 400); } catch (e) {}
  if (room !== LOBBY) { const L = roomsRead_(), r = L.find(x => x.id === room); if (r && Date.now() - r.last > 60000) { r.last = Date.now(); roomsWrite_(L); } }
}
function roomsAction_(action, req, w) {
  const L = roomsRead_();
  if (action === 'rooms') return {ok:true, rooms:[{id:LOBBY, name:'전체', lock:false, owner:'대장간'}].concat(L.slice().sort((a,b) => b.last - a.last).map(r => ({id:r.id, name:r.name, lock:!!r.pw, owner:r.ownerNick, mine:r.ownerId === w.id, last:r.last})))};
  if (action === 'roomCreate') {
    const name = String(req.name||'').replace(/\s+/g,' ').trim(), pw = String(req.pw||'');
    if (name.length < 2 || name.length > 20) return {ok:false, error:'방 이름은 2~20자로 정해 주세요'};
    if (pw && (pw.length < 4 || pw.length > 20)) return {ok:false, error:'비밀번호는 4~20자로 정해 주세요'};
    if (L.length >= ROOM_MAX) return {ok:false, error:'방이 너무 많습니다. 안 쓰는 방을 정리한 뒤 만들어 주세요'};
    if (L.filter(r => r.ownerId === w.id).length >= 3) return {ok:false, error:'한 사람이 만들 수 있는 방은 3개까지입니다'};
    const id = Utilities.getUuid().slice(0, 8);
    L.push({id, name, ownerId:w.id, ownerNick:w.nickname, pw: pw ? roomHash_(id, pw) : '', created:Date.now(), last:Date.now()});
    roomsWrite_(L);
    chatPush_({sys:true, nick:'대장간', text:`${w.nickname}님이 「${name}」 방을 열었습니다.`}, id);
    return {ok:true, room:{id, name, lock:!!pw}};
  }
  if (action === 'roomJoin') { const a = roomAccess_(String(req.room||''), req.pw); return typeof a === 'string' ? {ok:false, error:a} : {ok:true, room:{id:a.id, name:a.name, lock:!!a.pw}}; }
  if (action === 'roomDelete') {
    const i = L.findIndex(r => r.id === String(req.room||''));
    if (i < 0) return {ok:false, error:'없어진 방입니다'};
    if (L[i].ownerId !== w.id && w.role !== 'admin') return {ok:false, error:'방을 만든 사람만 없앨 수 있습니다'};
    const nm = L[i].name; L.splice(i, 1); roomsWrite_(L); CacheService.getScriptCache().remove('chat_' + String(req.room));
    return {ok:true, name:nm};
  }
}
// ── 공개 강화 (라이브) ─────────────────────────────────────
function liveRead_() { const v = CacheService.getScriptCache().get('live'); return v ? JSON.parse(v) : {seq:0, ev:[]}; }
function livePush_(e) {
  const c = CacheService.getScriptCache(), L = liveRead_();
  L.seq++; e.seq = L.seq; e.ts = Date.now(); L.ev.push(e); if (L.ev.length > 60) L.ev = L.ev.slice(-60);
  c.put('live', JSON.stringify(L), 21600);
}
// 공개 강화장에 들어와 있는 사람 (30초 안에 신호를 보낸 사람)
function watchers_(me) {
  const c = CacheService.getScriptCache(), now = Date.now();
  let w = {}; try { w = JSON.parse(c.get('watchers') || '{}'); } catch (e) {}
  if (me) { if (me.leave) delete w[me.id]; else w[me.id] = {nick:me.nick, ts:now}; }
  Object.keys(w).forEach(k => { if (now - w[k].ts > 30000) delete w[k]; });
  if (me) c.put('watchers', JSON.stringify(w), 3600);
  return Object.keys(w).map(k => w[k].nick);
}
function needApproval_() { return String(settings_().require_approval).toUpperCase() !== 'FALSE'; }
function hash_(nick, pin) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, nick+':'+pin+':sword-forge');
  return Utilities.base64Encode(raw);
}
function fresh_() { return {v:STATE_VER, daily:{}, gold:START_GOLD, lv:0, line:null, best:0, scrolls:0, seen:{}, tries:0, ok:0, broke:0, sold:0, wins:0, losses:0, defWins:0, nextFight:0, log:[]}; }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }
function daily_(st) { const d = today_(); if (!st.daily || st.daily.date !== d) st.daily = {date:d, aid:0, battles:0}; return st.daily; }
const BANKRUPT_GOLD = 10000;   // 골드 + 지금 검 판매가가 이 금액 이하면 파산
function bankrupt_(st) { return st.gold + sellOf(st.lv, st.line) <= BANKRUPT_GOLD; }
function migrate_(st) { if ((st.v||1) < STATE_VER) { st.gold = Math.max(st.gold, START_GOLD); st.v = STATE_VER; } return st; }
function say_(st, out, text, kind) {
  const t = Utilities.formatDate(new Date(), 'Asia/Seoul', 'HH:mm');
  const m = {text, kind:kind||'', t}; st.log = st.log || []; st.log.push(m); if (st.log.length > 40) st.log.shift();
  if (out && out.msgs) out.msgs.push(m);   // 배틀 상대처럼 화면이 없는 쪽은 기록에만 남김
}

// ── 라우터 ────────────────────────────────────────────────
function api(action, req) {
  req = req || {};
  try {
    if (action === 'bootstrap') return {ok:true, tapBonus:TAP_BONUS, gift:{min:GIFT_MIN, fee:GIFT_FEE, perDay:GIFT_PER_DAY, dayMax:GIFT_DAY_MAX, ageH:GIFT_AGE_H}, dungeons:DUNGEONS, huntCapH:HUNT_CAP_H, buffs:BUFFS.map(b=>({key:b[0],name:b[1],n:b[2],desc:b[4]})), guardMax:GUARD_MAX, types:TYPE_OF, beats:BEATS, protectMax:PROTECT_MAX, lines:LINES.map(l=>({n:l.n,h:l.h,t:TYPE_OF[l.n]||'',names:l.names,desc:DESC[l.n]||[]})), baseDesc:BASE_DESC, odds:ODDS, base:BASE, max:MAX, url:(function(){try{return ScriptApp.getService().getUrl()}catch(e){return ''}})()};
    if (action === 'register') return register_(req);
    if (action === 'login') return login_(req);
    if (action === 'board') return board_(req);
    if (action === 'sprite') return sprite_(+req.line);
    if (action === 'dex') {
      const me = findBy_('token', String(req.token||''));
      if (!me || me.status !== 'ok') return {ok:false, error:'로그인이 필요합니다'};
      const t = findBy_('id', String(req.id||''));
      if (!t || t.status !== 'ok') return {ok:false, error:'플레이어를 찾을 수 없습니다'};
      const tst = Object.assign(fresh_(), JSON.parse(t.state||'{}'));
      return {ok:true, nickname:t.nickname, seen:tst.seen||{}, best:tst.best||0, lv:t.lv, line:t.line};
    }
    if (action === 'live') { const L = liveRead_(), since = +req.since || 0, cs = +req.chatSince || 0;
      const out = {ok:true, seq:L.seq, ev:L.ev.filter(e => e.seq > since), watchers:watchers_(null), min:PUBLIC_MIN};
      const acc = roomAccess_(String(req.room||LOBBY), req.roomPw);
      if (typeof acc === 'string') { out.roomError = acc; out.room = LOBBY; }
      else { const C = chatRead_(acc.id); out.room = acc.id; out.chatSeq = C.seq; out.chat = C.msgs.filter(m => m.seq > cs); }
      return out; }
    if (['rooms','roomCreate','roomJoin','roomDelete'].indexOf(action) >= 0) {
      const w = findBy_('token', String(req.token||''));
      if (!w || w.status !== 'ok') return {ok:false, error:'로그인이 필요합니다'};
      const lock = LockService.getScriptLock(); lock.waitLock(10000);
      try { return roomsAction_(action, req, w); } finally { lock.releaseLock(); }
    }
    if (action === 'chat') {
      const w = findBy_('token', String(req.token||''));
      if (!w || w.status !== 'ok') return {ok:false, error:'로그인이 필요합니다'};
      const text = String(req.text||'').replace(/\s+/g,' ').trim().slice(0, 120);
      if (!text) return {ok:false, error:'메시지를 입력해 주세요'};
      const acc = roomAccess_(String(req.room||LOBBY), req.roomPw);
      if (typeof acc === 'string') return {ok:false, error:acc, roomError:true};
      const c = CacheService.getScriptCache(), rk = 'cr_' + w.id;
      if (c.get(rk)) return {ok:false, error:'너무 빨라요. 잠시 뒤에 보내 주세요'};
      c.put(rk, '1', 2);
      const lock = LockService.getScriptLock(); lock.waitLock(10000);
      try { chatPush_({id:w.id, nick:w.nickname, text}, acc.id); } finally { lock.releaseLock(); }
      return {ok:true};
    }
    if (action === 'watch') {
      const w = findBy_('token', String(req.token||''));
      if (!w || w.status !== 'ok') return {ok:false};
      return {ok:true, watchers:watchers_(req.leave ? {id:w.id, leave:true} : {id:w.id, nick:w.nickname})};
    }
    const lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      const row = findBy_('token', String(req.token||''));
      if (!row) return {ok:false, error:'로그인이 필요합니다', needLogin:true};
      if (row.status === 'pending' && !needApproval_()) { players_().getRange(row.row, 11).setValue('ok'); row.status = 'ok'; feed_(`${row.nickname}님이 대장간에 들어왔습니다.`); }
      if (row.status !== 'ok') return {ok:false, error:'가입 승인을 기다리는 중입니다', pending:true};
      if (['pending','approve','reject','give','roster','setApproval'].indexOf(action) >= 0) return admin_(action, req, row);
      const st = migrate_(Object.assign(fresh_(), JSON.parse(row.state||'{}')));
      const out = {msgs:[], fx:null};
      const fn = {me:()=>{}, enhance:enhance_, sell:sell_, buyScroll:buyScroll_, aid:aid_, battle:battle_, cheer:cheer_, huntSet:huntSet_, huntStop:huntStop_, huntClaim:huntClaim_, gift:gift_}[action];
      if (fn && action !== 'cheer') settle_(st, out);
      if (!fn) return {ok:false, error:'알 수 없는 요청: '+action};
      const err = fn(st, req, out, row);
      if (err) { if (out.goblins) save_(row, st); return {ok:false, error:err, state:pub_(st, row), goblins:out.goblins||null}; }
      if (action !== 'cheer') { fitHunt_(st, out); save_(row, st); }
      return {ok:true, state:pub_(st, row), msgs:out.msgs, fx:out.fx, battle:out.battle||null, goblins:out.goblins||null};
    } finally { lock.releaseLock(); }
  } catch (e) { return {ok:false, error:String(e && e.message || e)}; }
}
function pub_(st, row) {
  const dl = daily_(st);
  hunt_(st);
  return Object.assign({}, st, giftInfo_(st, row), {now:Date.now(), huntGph:st.hunt.d>=0?huntGph(st.hunt.d):0, huntCap:st.hunt.d>=0?huntGph(st.hunt.d)*HUNT_CAP_H:0, protectCost:protectCost(st), protectOk:st.lv < PROTECT_MAX, type:typeOf(st.line), aidLeft:AID_PER_DAY-dl.aid, battlesLeft:BATTLE_PER_DAY-dl.battles, bankrupt:bankrupt_(st), aidGold:AID_GOLD, nickname:row.nickname, id:row.id, role:row.role, name:nameOf(st.lv, st.line), cost:st.lv>=MAX?null:cost(st.lv), sell:sellOf(st.lv, st.line), scrollPrice:scrollPrice(st.lv), hidden:isHidden(st.line), lineName:st.line==null?null:LINES[st.line].n});
}

// ── 계정 ──────────────────────────────────────────────────
function register_(req) {
  const nick = String(req.nickname||'').trim(), pin = String(req.pin||''), code = String(req.code||'').trim();
  const intro = String(req.intro||'').trim().slice(0, 40);
  if (!/^[가-힣A-Za-z0-9_]{2,10}$/.test(nick)) return {ok:false, error:'닉네임은 한글·영문·숫자 2~10자로 정해 주세요'};
  if (!/^\d{4}$/.test(pin)) return {ok:false, error:'비밀번호는 숫자 4자리로 정해 주세요'};
  const set = settings_();
  let role = 'player', status;
  if (code && code === set.admin_code) { role = 'admin'; status = 'ok'; }
  else status = String(set.require_approval).toUpperCase() === 'FALSE' ? 'ok' : 'pending';   // 초대 코드 없이 가입 신청
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const rows = allRows_();
    if (rows.some(r => r.nickname === nick)) return {ok:false, error:'이미 있는 닉네임입니다. 내 닉네임이면 로그인을 누르세요'};
    if (status === 'pending' && rows.filter(r => r.status === 'pending').length >= 30) return {ok:false, error:'승인 대기 중인 신청이 너무 많습니다. 잠시 뒤에 다시 신청해 주세요'};
    const id = Utilities.getUuid().slice(0,8), token = Utilities.getUuid();
    const st = fresh_(); st.log.push({text:`대장간에 오신 것을 환영합니다. 녹슨 부지깽이 하나와 ${fmt(START_GOLD)} G로 시작합니다.`, kind:'gold', t:''});
    players_().appendRow([id, nick, hash_(nick,pin), token, 0, 0, '', START_GOLD, JSON.stringify(st), new Date(), status, role, intro, new Date()]);
    if (status === 'ok') feed_(`${nick}님이 대장간에 들어왔습니다.`);
    return {ok:true, token, status};
  } finally { lock.releaseLock(); }
}
function login_(req) {
  const nick = String(req.nickname||'').trim(), pin = String(req.pin||'');
  const row = findBy_('nickname', nick);
  if (!row || row.pinHash !== hash_(nick,pin)) return {ok:false, error:'닉네임 또는 비밀번호가 맞지 않습니다'};
  return {ok:true, token:row.token, status:row.status};
}
function admin_(action, req, row) {
  if (row.role !== 'admin') return {ok:false, error:'관리자만 할 수 있습니다'};
  if (action === 'pending') {
    const set = settings_();
    return {ok:true, list:allRows_().filter(r => r.status === 'pending').map(r => ({id:r.id, nickname:r.nickname, intro:r.intro, created:r.created ? Utilities.formatDate(new Date(r.created),'Asia/Seoul','MM.dd HH:mm') : ''})), invite:set.invite_code, approval:set.require_approval};
  }
  if (action === 'setApproval') {
    const sh = sheet_('settings', ['key','value','설명']), n = sh.getLastRow();
    const keys = n > 1 ? sh.getRange(2,1,n-1,1).getValues().map(r => String(r[0]).trim()) : [];
    const at = keys.indexOf('require_approval'), v = req.on ? 'TRUE' : 'FALSE';
    if (at >= 0) sh.getRange(at+2, 2).setValue(v); else sh.appendRow(['require_approval', v, 'TRUE 면 관리자가 승인해야 플레이할 수 있습니다']);
    CacheService.getScriptCache().remove('settings');
    let moved = 0;
    if (!req.on) allRows_().filter(r => r.status === 'pending').forEach(r => { players_().getRange(r.row, 11).setValue('ok'); feed_(`${r.nickname}님이 대장간에 들어왔습니다.`); moved++; });
    return {ok:true, approval:v, approved:moved};
  }
  if (action === 'roster') return {ok:true, list:allRows_().filter(r => r.status === 'ok').map(r => ({id:r.id, nickname:r.nickname, gold:r.gold, lv:r.lv}))};
  if (action === 'give') {
    const amt = Math.round(Number(req.amount));
    if (!isFinite(amt) || amt === 0 || Math.abs(amt) > 1e12) return {ok:false, error:'금액을 확인해 주세요'};
    {
      const g = findBy_('id', String(req.id||''));
      if (!g || g.status !== 'ok') return {ok:false, error:'플레이어를 찾을 수 없습니다'};
      const gst = migrate_(Object.assign(fresh_(), JSON.parse(g.state||'{}')));
      gst.gold = Math.max(0, gst.gold + amt);
      const memo = String(req.memo||'').trim().slice(0,40);
      gst.log = gst.log || []; gst.log.push({text:`관리자가 ${amt>0?'':'회수: '}${fmt(Math.abs(amt))} G${amt>0?'를 보냈습니다':'를 가져갔습니다'}.${memo?' 「'+memo+'」':''}`, kind:'gold', t:Utilities.formatDate(new Date(),'Asia/Seoul','HH:mm')});
      if (gst.log.length > 40) gst.log = gst.log.slice(-40);
      save_(g, gst);
      return {ok:true, gold:gst.gold, nickname:g.nickname};
    }
  }
  const t = findBy_('id', String(req.id||''));
  if (!t || t.status !== 'pending') return {ok:false, error:'신청을 찾을 수 없습니다'};
  if (action === 'approve') { players_().getRange(t.row, 11).setValue('ok'); feed_(`${t.nickname}님이 대장간에 들어왔습니다.`); }
  else players_().deleteRow(t.row);
  return {ok:true};
}

// ── 게임 동작 ─────────────────────────────────────────────
function pickLine_() {
  const r = Math.random()*100;
  if (r < SECRET.length*HIDDEN_EACH) return SECRET[Math.floor(r/HIDDEN_EACH)];
  return NORMAL[Math.floor(Math.random()*NORMAL.length)];
}
function enhance_(st, req, out, row) {
  if (st.lv >= MAX) return '이미 최고 단계입니다';
  if (req.public && st.lv < PUBLIC_MIN) return `공개 강화는 +${PUBLIC_MIN} 검부터 할 수 있습니다`;
  hunt_(st); const B = st.buffs;
  const useFree = (B.free||0) > 0, useLuck = (B.luck||0) > 0, useGuard = (B.guard||0) > 0 && st.lv < GUARD_MAX;
  const c = useFree ? 0 : cost(st.lv), prot = !!req.useScroll && !useGuard;
  if (prot && st.lv >= PROTECT_MAX) return `+${PROTECT_MAX}부터는 파괴 방지를 쓸 수 없습니다`;
  const pc = prot ? protectCost(st) : 0;
  if (st.gold < c + pc) return prot ? `골드가 부족합니다 (강화비 ${fmt(c)} G + 파괴 방지 ${fmt(pc)} G)` : '골드가 부족합니다';
  st.gold -= c + pc; st.tries++;
  if (useFree) B.free--; if (useLuck) B.luck--; if (useGuard) B.guard--;
  const before = st.lv, beforeName = nameOf(st.lv, st.line), beforeLine = st.line;
  let [s,d] = ODDS[st.lv]; if (useLuck) s = Math.min(100 - d, s + 5);
  const tapHit = req.tap === true; if (tapHit) s = Math.min(100 - d, s + TAP_BONUS);   // 직접 두들기기 명중
  const r = Math.random()*100;
  if (r < s) {
    if (st.lv === 0) {
      st.line = pickLine_(); const L = LINES[st.line];
      if (L.h) { try { chatPush_({sys:true, nick:'대장간', text:`✨ 히든 발견! ${row.nickname}님이 ${L.n} 계열을 찾았습니다!`}); } catch (e) {}
        say_(st,out,`히든 발견! 부지깽이가 「${L.names[0]}」(으)로 변했습니다. ${L.n} 계열은 히든 판매가로 팔립니다.`,'gold'); feed_(`${row.nickname}님이 히든 ${L.n} 계열을 발견했습니다!`); out.fx='hidden'; }
      else say_(st,out,`부지깽이의 정체가 드러났습니다. ${L.n} 계열 「${L.names[0]}」입니다.`,'ok');
    }
    st.lv++; st.ok++;
    const k = String(st.line); if (!(st.seen[k] >= st.lv)) st.seen[k] = st.lv;
    const rec = st.lv > st.best; if (rec) st.best = st.lv;
    if (st.lv > 1) say_(st,out,`강화 성공 → +${st.lv} ${nameOf(st.lv,st.line)}${rec?' (최고 기록 경신)':''}`,'ok');
    if (st.lv >= 10) feed_(`${row.nickname}님이 +${st.lv} ${nameOf(st.lv,st.line)}을(를) 띄웠습니다.`);
    if (st.lv >= HIGH_LV) {   // 고강 성공은 모두에게 알림
      chatPush_({sys:true, nick:'대장간', text:`🎉 고강 성공! ${row.nickname}님이 +${st.lv} ${nameOf(st.lv,st.line)}을(를) 띄웠습니다!`});
      livePush_({type:'high', id:row.id, nick:row.nickname, lv:st.lv, name:nameOf(st.lv,st.line), line:st.line});
    }
    out.fx = out.fx || 'success';
  } else if (r < s+d) {
    if (useGuard) { say_(st,out,`파괴될 뻔했지만 황금 방패가 막았습니다. +${st.lv} 유지 (남은 ${B.guard}회)`,'gold'); out.fx='saved'; }
    else if (prot) { say_(st,out,`파괴될 뻔했지만 파괴 방지(${fmt(pc)} G)로 +${st.lv} 유지`,'gold'); out.fx='saved'; }
    else {
      const was = st.lv, nm = nameOf(st.lv,st.line);
      st.lv = 0; st.line = null; st.broke++;
      say_(st,out,`+${was} ${nm}이(가) 산산조각 났습니다. 새 부지깽이를 받았습니다.`,'bad');
      if (was >= 8) feed_(`${row.nickname}님의 +${was} ${nm}이(가) 파괴되었습니다.`);
      out.fx = 'destroy';
    }
  } else { say_(st,out,`강화 실패. +${st.lv} 그대로입니다.`); out.fx='keep'; }
  if (req.public) livePush_({type:'enh', id:row.id, nick:row.nickname, before, beforeName, beforeLine, line:st.line, after:st.lv, name:nameOf(st.lv, st.line), hidden:isHidden(st.line), result:out.fx, odds:ODDS[before]});
}

// ── 자동 사냥 (던전 10단계) ─────────────────────────────────
// [이름, 바위, 필요 강화 단계, 시간당 골드]
// 시간당 골드는 그 던전에 들어갈 수 있는 단계의 강화비·판매가에 맞춰 잡았습니다.
// 예) 5층(+9): 한 시간이면 +9 검 판매가(3만)의 약 1.7배, 8층(+15): +15 판매가(330만)를 모으려면 약 12시간.
const DUNGEONS = [
  ['조약돌 개울', '조약돌', 1, 3000],
  ['바위 언덕', '바위', 3, 6000],
  ['화강암 협곡', '화강암', 5, 12000],
  ['현무암 동굴', '현무암', 7, 25000],
  ['흑요석 광산', '흑요석', 9, 50000],
  ['수정 동굴', '수정 바위', 11, 90000],
  ['용암 지대', '용암석', 13, 160000],
  ['운석 분화구', '운석', 15, 280000],
  ['미스릴 광맥', '미스릴 원석', 17, 450000],
  ['별의 심연', '별의 핵', 19, 700000]];
const HUNT_CAP_H = 8;                 // 접속하지 않아도 최대 8시간치까지 주머니에 쌓임
const GOBLIN_EVERY = 10 * 60 * 1000;  // 사냥 10분마다 한 번
const GOBLIN_P = 1 / 12;              // 그때 황금고블린이 나올 확률 (평균 2시간에 한 마리)
const GUARD_MAX = 12;                 // 황금 방패는 +12 미만 강화에서만
const TAP_BONUS = 5;                  // 직접 두들기기 미니게임 명중 시 성공 확률 +5%p
// 황금고블린이 주는 버프 [key, 이름, 횟수, 가중치, 설명]
const BUFFS = [
  ['guard', '황금 방패', 15, 30, `+${GUARD_MAX} 미만 강화에서 파괴가 나와도 유지`],
  ['luck',  '황금 행운', 10, 30, '강화 성공 확률 +5%p'],
  ['free',  '황금 망치', 10, 25, '강화비 무료'],
  ['pouch', '황금 주머니', 0, 15, '지금 던전 1시간치 골드를 바로 받음']];
const huntReq = d => DUNGEONS[d][2];
const huntGph = d => DUNGEONS[d][3];
function hunt_(st) { st.hunt = st.hunt || {d:-1, since:0, pouch:0, gt:0}; st.buffs = st.buffs || {}; return st.hunt; }
function bestDungeon_(lv) { let b = -1; DUNGEONS.forEach((x, i) => { if (lv >= x[2]) b = i; }); return b; }
// 지난 정산 뒤 흐른 시간만큼 주머니에 골드를 넣고, 10분마다 황금고블린을 굴림
function settle_(st, out) {
  const h = hunt_(st), now = Date.now();
  if (h.d < 0 || !h.since) { h.since = now; h.gt = now; return; }
  const gph = huntGph(h.d), cap = gph * HUNT_CAP_H, el = Math.max(0, now - h.since);
  const room = Math.max(0, cap - h.pouch);
  h.pouch = Math.min(cap, h.pouch + gph * el / 3600000);
  // 주머니가 가득 찬 뒤의 시간에는 고블린도 나오지 않음
  const activeMs = gph > 0 ? Math.min(el, room / gph * 3600000) : 0;
  let blocks = Math.floor((Math.min(now, h.since + activeMs) - (h.gt || h.since)) / GOBLIN_EVERY);
  blocks = Math.max(0, Math.min(blocks, HUNT_CAP_H * 6));
  for (let i = 0; i < blocks; i++) if (Math.random() < GOBLIN_P) goblin_(st, out);
  h.gt = (h.gt || h.since) + blocks * GOBLIN_EVERY;
  if (h.pouch >= cap) h.gt = now;
  h.since = now;
}
function goblin_(st, out) {
  const tot = BUFFS.reduce((t, b) => t + b[3], 0); let r = Math.random() * tot, pick = BUFFS[0];
  for (const b of BUFFS) { if ((r -= b[3]) < 0) { pick = b; break; } }
  const h = hunt_(st), ev = {key:pick[0], name:pick[1], n:pick[2], desc:pick[4]};
  if (pick[0] === 'pouch') { const g = huntGph(Math.max(0, h.d)); st.gold += g; ev.gold = g; say_(st, out, `황금고블린을 잡았다! 황금 주머니에서 ${fmt(g)} G가 나왔습니다.`, 'gold'); }
  else { st.buffs[pick[0]] = (st.buffs[pick[0]] || 0) + pick[2]; say_(st, out, `황금고블린을 잡았다! ${pick[1]} ${pick[2]}회 (${pick[4]})`, 'gold'); }
  if (out) (out.goblins = out.goblins || []).push(ev);
}
// 검 단계가 던전 조건보다 낮아지면 들어갈 수 있는 가장 높은 던전으로 옮김
function fitHunt_(st, out) {
  const h = hunt_(st); if (h.d < 0 || st.lv >= huntReq(h.d)) return;
  const b = bestDungeon_(st.lv), from = DUNGEONS[h.d][0];
  h.d = b; h.since = Date.now(); h.gt = h.since;
  if (out) say_(st, out, b < 0 ? `검이 없어 ${from} 사냥을 멈췄습니다. 검을 다시 키워 오세요.` : `검이 약해져 ${from}에서 ${DUNGEONS[b][0]}(으)로 내려왔습니다.`, b < 0 ? 'bad' : '');
}
function huntSet_(st, req, out) {
  const d = Math.floor(+req.d);
  if (!(d >= 0 && d < DUNGEONS.length)) return '없는 던전입니다';
  if (st.lv < huntReq(d)) return `${DUNGEONS[d][0]}은(는) +${huntReq(d)} 이상 검이 있어야 들어갈 수 있습니다`;
  const h = hunt_(st); h.d = d; h.since = Date.now(); h.gt = h.since;
  say_(st, out, `${d + 1}층 ${DUNGEONS[d][0]}에서 사냥을 시작했습니다. 시간당 ${fmt(huntGph(d))} G`, 'ok'); out.fx = 'hunt';
}
function huntStop_(st, req, out) { const h = hunt_(st); if (h.d < 0) return '사냥 중이 아닙니다'; say_(st, out, `${DUNGEONS[h.d][0]} 사냥을 멈췄습니다. 주머니 골드는 그대로 남아 있습니다.`); h.d = -1; }
function huntClaim_(st, req, out) {
  const h = hunt_(st), g = Math.floor(h.pouch);
  if (g < 1) return '주머니가 비어 있습니다';
  st.gold += g; h.pouch -= g;
  say_(st, out, `사냥 주머니에서 ${fmt(g)} G를 꺼냈습니다.`, 'gold'); out.fx = 'claim';
}

// ── 골드 선물 (유저끼리 보내기) ─────────────────────────────
// 부계정으로 지원금을 모아 몰아주는 것을 막으려고 수수료·하루 한도·가입 24시간 조건을 둡니다.
const GIFT_MIN = 100, GIFT_FEE = 0.05, GIFT_PER_DAY = 5, GIFT_DAY_MAX = 5000000, GIFT_AGE_H = 24;
function giftInfo_(st, row) {
  const dl = daily_(st), age = (Date.now() - new Date(row.created || 0).getTime()) / 3600000;
  return {giftsLeft: GIFT_PER_DAY - (dl.gifts||0), giftRoom: GIFT_DAY_MAX - (dl.giftSum||0), giftAgeOk: !(age < GIFT_AGE_H), giftAgeLeftH: Math.max(0, Math.ceil(GIFT_AGE_H - age))};
}
function gift_(st, req, out, row) {
  const dl = daily_(st), gi = giftInfo_(st, row);
  const amt = Math.floor(+req.amount);
  if (!(amt >= GIFT_MIN)) return `최소 ${fmt(GIFT_MIN)} G부터 보낼 수 있습니다`;
  if (!gi.giftAgeOk) return `가입하고 ${GIFT_AGE_H}시간이 지나야 선물할 수 있습니다 (약 ${gi.giftAgeLeftH}시간 남음)`;
  const to = findBy_('id', String(req.to||''));
  if (!to || to.id === row.id || to.status !== 'ok') return '받을 사람을 찾을 수 없습니다';
  if (gi.giftsLeft <= 0) return `선물은 하루 ${GIFT_PER_DAY}번까지 보낼 수 있습니다`;
  if (amt > gi.giftRoom) return `오늘은 ${fmt(Math.max(0, gi.giftRoom))} G까지 더 보낼 수 있습니다 (하루 ${fmt(GIFT_DAY_MAX)} G)`;
  const fee = Math.ceil(amt * GIFT_FEE);
  if (st.gold < amt + fee) return `골드가 부족합니다 (보낼 ${fmt(amt)} G + 수수료 ${fmt(fee)} G)`;
  const note = String(req.note||'').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
  st.gold -= amt + fee; dl.gifts = (dl.gifts||0) + 1; dl.giftSum = (dl.giftSum||0) + amt;
  const tst = migrate_(Object.assign(fresh_(), JSON.parse(to.state||'{}'))); settle_(tst, null);
  tst.gold += amt;
  say_(tst, null, `🎁 ${row.nickname}님이 ${fmt(amt)} G를 보냈습니다.${note ? ` "${note}"` : ''}`, 'gold');
  fitHunt_(tst, null); save_(to, tst);
  say_(st, out, `🎁 ${to.nickname}님에게 ${fmt(amt)} G를 보냈습니다. (수수료 ${fmt(fee)} G)`, 'gold'); out.fx = 'gift';
  feed_(`🎁 ${row.nickname}님이 ${to.nickname}님에게 ${fmt(amt)} G를 선물했습니다.`);
  livePush_({type:'gift', id:row.id, nick:row.nickname, to:to.id, toNick:to.nickname, amount:amt, note});
}
function cheer_(st, req, out, row) {
  const ok = ['👏','🔥','😱','🙏','😂'];
  const e = ok.indexOf(req.emoji) >= 0 ? req.emoji : '👏';
  livePush_({type:'cheer', id:row.id, nick:row.nickname, emoji:e, to:String(req.to||'')});
}
function sell_(st, req, out, row) {
  if (!st.lv) return '+0 부지깽이는 팔 수 없습니다';
  const p = sellOf(st.lv, st.line), h = isHidden(st.line), nm = nameOf(st.lv, st.line), lv = st.lv;
  st.gold += p; st.sold++;
  say_(st,out,`+${lv} ${nm}을(를) ${fmt(p)} G에 팔았습니다.${h?' (히든 판매가)':''}`,'gold');
  if (lv >= 10) feed_(`${row.nickname}님이 +${lv} ${nm}을(를) ${fmt(p)} G에 팔았습니다.`);
  st.lv = 0; st.line = null; out.fx = 'sell';
}
function buyScroll_(st, req, out) { return '파괴 방지권 구매는 없어졌습니다. 강화할 때 「파괴 방지」를 체크하면 그때 비용을 냅니다'; }
function aid_(st, req, out) {
  const dl = daily_(st);
  if (!bankrupt_(st)) return `파산 지원금은 골드와 검 판매가를 합쳐 ${fmt(BANKRUPT_GOLD)} G 이하일 때만 받을 수 있습니다`;
  if (dl.aid >= AID_PER_DAY) return `오늘 파산 지원금 ${AID_PER_DAY}회를 모두 받았습니다. 내일 다시 받을 수 있습니다`;
  dl.aid++; st.gold += AID_GOLD;
  say_(st,out,`파산 지원금 ${fmt(AID_GOLD)} G를 받았습니다. (오늘 남은 횟수 ${AID_PER_DAY-dl.aid}회)`,'gold');
  out.fx = 'aid';
}
// 배틀 패배 시 단계 하락 확률: 낮은 단계일수록 잘 떨어지고, 높을수록 잘 버팀
// +1 70% · +5 58% · +10 43% · +15 28% · +20 13% (최저 10%)
function dropP(lv) { return lv <= 0 ? 0 : Math.max(0.10, 0.70 - 0.03 * (lv - 1)); }
function drop_(st) {   // 확률로 강화 단계 -1. 떨어지면 true
  if (st.lv <= 0 || Math.random() >= dropP(st.lv)) return false;
  st.lv--; if (st.lv === 0) st.line = null;
  return true;
}
function battle_(st, req, out, row) {
  const dl = daily_(st);
  if (dl.battles >= BATTLE_PER_DAY) return `오늘 배틀 ${BATTLE_PER_DAY}회를 모두 썼습니다. 내일 다시 도전하세요`;
  if (Date.now() < (st.nextFight||0)) return '숨 고르는 중입니다. 잠시 뒤에 다시 도전하세요';
  const foe = findBy_('id', String(req.targetId||''));
  if (!foe || foe.id === row.id || foe.status !== 'ok') return '상대를 찾을 수 없습니다';
  const fst = migrate_(Object.assign(fresh_(), JSON.parse(foe.state||'{}'))); settle_(fst, null);
  const f = fee(fst.lv), pz = prize(fst.lv);
  if (st.gold < f) return `참가비 ${fmt(f)} G가 필요합니다`;
  const myLv = st.lv, foeLv = fst.lv;
  const m = matchup_(st.line, fst.line, true);
  const win = Math.random() < winP(myLv + MATCH_BONUS * m, foeLv);
  const mt = m > 0 ? ' [상성 유리]' : m < 0 ? ' [상성 불리]' : '';
  st.nextFight = Date.now() + 3000; dl.battles++;
  const t = Utilities.formatDate(new Date(),'Asia/Seoul','HH:mm');
  fst.log = fst.log || [];
  if (win) {
    st.wins++; st.gold += pz;
    const fName = nameOf(foeLv, fst.line), foeLine0 = fst.line, d = drop_(fst);
    fst.log.push({text:`${row.nickname}님(+${myLv})에게 졌습니다.${d ? ` 검이 +${fst.lv}로 떨어졌습니다.` : ' 검은 버텨 냈습니다.'}`, kind:'bad', t});
    say_(st,out,`배틀 승리!${mt} ${foe.nickname}의 +${foeLv} ${fName}을(를) 꺾고 ${fmt(pz)} G를 받았습니다. ${d ? `상대 검이 +${fst.lv}로 떨어졌습니다.` : '상대 검은 버텨 냈습니다.'} (오늘 남은 배틀 ${BATTLE_PER_DAY-dl.battles}회)`,'ok'); out.fx='win';
    out.battle = {win:true, drop:d, mt:m, me:{nick:row.nickname, line:st.line, lv:myLv}, foe:{nick:foe.nickname, line:foeLine0, lv:foeLv}};
    feed_(`${row.nickname}님(+${myLv})이 ${foe.nickname}님(+${foeLv})을 이겼습니다.${d ? ` ${foe.nickname}님의 검이 +${fst.lv}로 떨어졌습니다.` : ''}`);
    if (d) livePush_({type:'drop', to:foe.id, id:row.id, nick:row.nickname, byLv:myLv, from:foeLv, lv:fst.lv, name:nameOf(fst.lv, fst.line), line:fst.line});   // 상대가 접속 중이면 바로 알림
  } else {
    st.losses++; st.gold -= f; fst.gold += f; fst.defWins = (fst.defWins||0)+1;
    const myLine0 = st.line, d = drop_(st);
    fst.log.push({text:`${row.nickname}님의 도전을 막아 내고 참가비 ${fmt(f)} G를 받았습니다.`, kind:'gold', t});
    say_(st,out,`배틀 패배.${mt} ${foe.nickname}의 +${foeLv} ${nameOf(foeLv, fst.line)}에게 져서 참가비 ${fmt(f)} G를 냈습니다.${d ? ` 검이 +${st.lv}로 떨어졌습니다.` : ' 다행히 검은 버텨 냈습니다.'} (오늘 남은 배틀 ${BATTLE_PER_DAY-dl.battles}회)`,'bad'); out.fx='lose';
    out.battle = {win:false, drop:d, mt:m, me:{nick:row.nickname, line:myLine0, lv:myLv}, foe:{nick:foe.nickname, line:fst.line, lv:foeLv}};
    feed_(`${foe.nickname}님(+${foeLv})이 ${row.nickname}님(+${myLv})의 도전을 막아 냈습니다.${d ? ` ${row.nickname}님의 검이 +${st.lv}로 떨어졌습니다.` : ''}`);
  }
  if (fst.log.length > 40) fst.log = fst.log.slice(-40);
  fitHunt_(fst, null); save_(foe, fst);
}
function board_(req) {
  const rows = allRows_().filter(r => r.status === 'ok'), me = rows.find(r => r.token === String(req.token||''));
  const list = rows.map(r => ({id:r.id, nickname:r.nickname, lv:r.lv, line:r.line, best:r.best, name:nameOf(r.lv, r.line), hidden:isHidden(r.line), gold:r.gold, me: !!me && r.id === me.id}));
  const ranking = list.slice().sort((a,b) => b.lv-a.lv || b.best-a.best || b.gold-a.gold).slice(0, 30);
  const myLv = me ? me.lv : 0;
  const myLine = me ? me.line : null;
  const foes = list.filter(x => !x.me).map(x => { const m = matchup_(myLine, x.line, false); return Object.assign(x, {type:typeOf(x.line), match:m, winP:Math.round(winP(myLv + MATCH_BONUS * (m||0), x.lv)*100), prize:prize(x.lv), fee:fee(x.lv)}); })
    .sort((a,b) => Math.abs(a.lv-myLv)-Math.abs(b.lv-myLv)).slice(0, 12);
  const sh = feedSheet_(), n = sh.getLastRow()-1;
  const feed = n < 1 ? [] : sh.getRange(Math.max(2, sh.getLastRow()-29), 1, Math.min(30, n), 2).getValues().reverse()
    .filter(r => Utilities.formatDate(new Date(r[0]), 'Asia/Seoul', 'yyyy-MM-dd') === today_())
    .map(r => ({t:Utilities.formatDate(new Date(r[0]), 'Asia/Seoul', 'HH:mm'), text:String(r[1])}));
  return {ok:true, ranking, foes, feed, players:rows.length};
}

// ════════════════ Cloudflare 연결부 ════════════════
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS) });

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS sheets (name TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cells (sheet TEXT NOT NULL, r INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (sheet, r))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)");
    this.mem = { sql: this.sql, sheets: new Map(), kv: null, kvDirty: new Set(), touched: new Set(), ping: false };
    // 연결 유지 신호는 서버를 깨우지 않고 바로 답합니다 (요금 없음)
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch (e) {}
  }
  flush_() {
    const m = this.mem;
    this.ctx.storage.transactionSync(() => {
      m.touched.forEach(sh => sh.flush(this.sql)); m.touched.clear();
      m.kvDirty.forEach(k => { const e = m.kv && m.kv.get(k); if (e) this.sql.exec("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)", k, e.v, e.exp); else this.sql.exec("DELETE FROM kv WHERE k = ?", k); });
      m.kvDirty.clear();
    });
  }
  broadcast_() {
    for (const ws of this.ctx.getWebSockets()) { try { ws.send("live"); } catch (e) {} }
  }
  run_(fn) {
    DB = this.mem; this.mem.ping = false;
    try { const out = fn(); this.flush_(); if (this.mem.ping) this.broadcast_(); return out; }
    catch (e) {   // 중간에 실패하면 메모리 사본을 버려 저장된 값과 어긋나지 않게 합니다
      this.mem.sheets.clear(); this.mem.kv = null; this.mem.kvDirty.clear(); this.mem.touched.clear();
      console.log("api error", e && e.stack || e); return { ok: false, error: "서버 오류가 났습니다. 잠시 뒤 다시 시도하세요" };
    }
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    let body = {}; try { body = JSON.parse(await req.text() || "{}"); } catch (e) {}
    if (body.action === "__import") return json(this.run_(() => importData_(body)));
    return json(this.run_(() => api(body.action, body)));
  }
  webSocketMessage(ws, msg) { if (msg === "ping") try { ws.send("pong"); } catch (e) {} }
  webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch (e) {} }
  webSocketError(ws) { try { ws.close(1011, "error"); } catch (e) {} }
}

// 구글 시트에서 옮겨 온 데이터를 한 번만 넣습니다 (players 가 비어 있을 때만)
function importData_(body) {
  const p = BOOK.getSheetByName("players");
  if (p && p.getLastRow() > 1) return { ok: false, error: "이미 데이터가 있어 가져오기를 막았습니다" };
  const got = {};
  Object.keys(body.sheets || {}).forEach(name => {
    if (["players", "settings", "rooms", "chat", "feed"].indexOf(name) < 0) return;
    const rows = body.sheets[name] || []; let sh = BOOK.getSheetByName(name) || BOOK.insertSheet(name);
    if (sh.getLastRow()) sh.deleteRows(1, sh.getLastRow());
    rows.forEach(r => sh.appendRow(r.map(v => (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) ? new Date(v) : v))));
    got[name] = rows.length;
  });
  CacheService.getScriptCache().remove("settings"); CacheService.getScriptCache().remove("rooms");
  return { ok: true, imported: got };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const stub = env.GAME.get(env.GAME.idFromName("main"));
    if (url.pathname === "/ws") return stub.fetch(req);
    if (req.method === "POST") return stub.fetch(req);
    return json({ ok: true, service: "검키우기 대장간 서버" });
  },
};
