/**
 * build-crx.js —— 生成可直接安装的 CRX 包（CRX3 格式）
 *
 * CRX3 文件结构：
 *   magic        "Cr24"                    4 字节
 *   version      3                         uint32 LE
 *   headerLen    N                         uint32 LE
 *   header       CrxFileHeader (protobuf)  N 字节
 *   payload      zip 内容
 *
 * protobuf 定义（crx_file.proto 子集）：
 *   CrXId              { bytes crx_id = 2; }
 *   SignedHeaderData   { bytes crx_id = 1; }        // 内容是 CrXId 的编码
 *   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
 *   CrxFileHeader      { repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *                        bytes signed_header_data = 10000; }
 *
 * 签名范围：signature = RSA-SHA256( crx_id || zip_data )
 *
 * 扩展 ID 规则：公钥 DER 的 SHA256 前 16 字节，每个半字节映射到 'a'~'p'
 *
 * 用法：node build-crx.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const KEY_FILE = path.join(ROOT, '.crx-key.pem');
const PY = process.env.BADC_PYTHON ||
  'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';

/* ============================================================
 * 极简 protobuf 编码
 * ========================================================== */

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** wire type 2 = length-delimited */
function fieldBytes(fieldNo, payload) {
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(payload.length), payload]);
}

/** CrXId { bytes crx_id = 2; } */
const encodeCrxId = (idBuf) => fieldBytes(2, idBuf);

/** SignedHeaderData { bytes crx_id = 1; } —— 内层是 CrXId 编码 */
const encodeSignedHeaderData = (idBuf) => fieldBytes(1, encodeCrxId(idBuf));

/** AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; } */
const encodeProof = (pubDer, sig) =>
  Buffer.concat([fieldBytes(1, pubDer), fieldBytes(2, sig)]);

/** CrxFileHeader { repeated sha256_with_rsa = 2; bytes signed_header_data = 10000; } */
const encodeHeader = (proof, signedHeaderData) =>
  Buffer.concat([fieldBytes(2, proof), fieldBytes(10000, signedHeaderData)]);

/* ============================================================
 * 扩展 ID 派生
 * ========================================================== */

function deriveExtensionId(pubKeyDer) {
  const h = crypto.createHash('sha256').update(pubKeyDer).digest();
  const map = 'abcdefghijklmnop';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += map[h[i] >> 4] + map[h[i] & 0x0f];
  }
  return id;
}

/* ============================================================
 * 密钥（持久化，保证扩展 ID 稳定）
 * ========================================================== */

function loadOrCreateKey() {
  if (fs.existsSync(KEY_FILE)) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE, 'utf8'));
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  console.log('[密钥] 已生成新签名密钥 → .crx-key.pem');
  console.log('[提示] 备份该文件；删除后扩展 ID 会改变，无法覆盖升级已有安装');
  return { privateKey, publicKey };
}

/* ============================================================
 * 打包
 * ========================================================== */

const readManifest = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** 调 build.py 生成 zip，返回 zip 内容（跳过 CRX 环节以免循环调用） */
function makeZip(version) {
  const env = { ...process.env, BADC_SKIP_CRX: '1' };
  execFileSync(PY, [path.join(ROOT, 'build.py')], { cwd: ROOT, stdio: 'ignore', env });
  const built = path.join(DIST, `search-ad-killer-v${version}.zip`);
  if (!fs.existsSync(built)) throw new Error('未找到 build.py 产出的 zip');
  return fs.readFileSync(built);
}

function buildCrx() {
  const manifest = readManifest();
  const version = manifest.version;
  const name = manifest.short_name || manifest.name;

  fs.mkdirSync(DIST, { recursive: true });

  const { privateKey, publicKey } = loadOrCreateKey();
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const extId = deriveExtensionId(pubDer);
  const idBuf = Buffer.from(extId, 'utf8');

  const zipBuf = makeZip(version);

  // signature = sign(crx_id || zip)
  const sig = crypto.sign('sha256', Buffer.concat([idBuf, zipBuf]), privateKey);

  const header = encodeHeader(encodeProof(pubDer, sig), encodeSignedHeaderData(idBuf));

  const crxPath = path.join(DIST, `search-ad-killer-v${version}.crx`);
  fs.writeFileSync(crxPath, Buffer.concat([
    Buffer.from('Cr24', 'ascii'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(3, 0); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(header.length, 0); return b; })(),
    header,
    zipBuf
  ]));

  const kb = fs.statSync(crxPath).size / 1024;
  console.log(`\n扩展      : ${name} v${version}`);
  console.log(`扩展 ID   : ${extId}`);
  console.log(`输出      : dist/search-ad-killer-v${version}.crx  (${kb.toFixed(1)} KB)`);
  console.log(`内置 zip  : ${(zipBuf.length / 1024).toFixed(1)} KB`);

  return { crxPath, extId, version };
}

module.exports = { buildCrx, deriveExtensionId, varint, fieldBytes };

if (require.main === module) {
  try {
    buildCrx();
    console.log('\n安装方式：');
    console.log('  Chrome  chrome://extensions/ → 开启「开发者模式」→ 把 .crx 拖入窗口');
    console.log('  Edge    不支持 CRX 侧载，请改用 dist/ 下的免解压目录（见安装说明.txt）');
  } catch (e) {
    console.error('[错误] 打包失败：', e.message);
    process.exit(1);
  }
}