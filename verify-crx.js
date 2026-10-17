/**
 * verify-crx.js —— CRX 二进制结构与签名校验
 *
 * 逐字节解析 CRX3 头，反解 protobuf，并：
 *   1. 校验 magic / version / headerLen
 *   2. 解析 CrxFileHeader，取出公钥与签名
 *   3. 验证签名确实覆盖 (crx_id || zip)
 *   4. 重新派生扩展 ID，与 signed_header_data 中的比对
 *   5. 把内层 zip 解出来，确认 manifest 在根且引用完整
 *   6. 在解压副本上跑完整测试，证明包内代码功能可用
 *
 * 用法：node verify-crx.js [crxPath]
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PY = process.env.BADC_PYTHON ||
  'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const NODE = process.execPath;

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  →  ' + extra : ''}`); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ---------- protobuf 最小解码器 ---------- */
function readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
}

/** 返回 [{fieldNo, wireType, value}] */
function decodeFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      out.push({ fieldNo, wireType, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wireType === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      out.push({ fieldNo, wireType, value: v });
    } else {
      throw new Error('不支持的 wire type: ' + wireType);
    }
  }
  return out;
}

function deriveExtensionId(pubKeyDer) {
  const h = crypto.createHash('sha256').update(pubKeyDer).digest();
  const map = 'abcdefghijklmnop';
  let id = '';
  for (let i = 0; i < 16; i++) id += map[h[i] >> 4] + map[h[i] & 0x0f];
  return id;
}

/* ---------- 主流程 ---------- */
const crxPath = process.argv[2] ||
  (() => {
    const d = path.join(ROOT, 'dist');
    const f = fs.readdirSync(d).filter((n) => n.endsWith('.crx'));
    if (!f.length) { console.error('未找到 .crx，请先运行 build-crx.js'); process.exit(1); }
    return path.join(d, f[0]);
  })();

console.log(`校验文件：${path.basename(crxPath)}`);
const buf = fs.readFileSync(crxPath);

section('CRX3 文件头');
const magic = buf.subarray(0, 4).toString('ascii');
check('magic 为 Cr24', magic === 'Cr24', magic);

const version = buf.readUInt32LE(4);
check('version 为 3', version === 3, String(version));

const headerLen = buf.readUInt32LE(8);
check('headerLen 与实际一致', headerLen > 0 && 8 + 4 + headerLen <= buf.length,
  `${headerLen} / 总长 ${buf.length}`);
check('headerLen 大小合理（< 2KB）', headerLen < 2048, `${headerLen} 字节`);

section('protobuf 解析');
let header, payload;
let pubDer, sig, signedHeaderData, extIdFromHeader;
try {
  header = buf.subarray(12, 12 + headerLen);
  payload = buf.subarray(12 + headerLen);

  const hFields = decodeFields(header);
  const proofField = hFields.find((f) => f.fieldNo === 2);
  const signedField = hFields.find((f) => f.fieldNo === 10000);

  check('CrxFileHeader 含 sha256_with_rsa (field 2)', !!proofField);
  check('CrxFileHeader 含 signed_header_data (field 10000)', !!signedField);

  const pFields = decodeFields(proofField.value);
  const pk = pFields.find((f) => f.fieldNo === 1);
  const sg = pFields.find((f) => f.fieldNo === 2);
  pubDer = pk.value;
  sig = sg.value;
  check('AsymmetricKeyProof 含 public_key', pubDer && pubDer.length > 0, `${pubDer && pubDer.length} 字节`);
  check('AsymmetricKeyProof 含 signature', sig && sig.length === 256, `${sig && sig.length} 字节`);

  // signed_header_data → SignedHeaderData{crx_id=1} → CrXId{crx_id=2}
  const shd = decodeFields(signedField.value);
  const crxIdWrap = shd.find((f) => f.fieldNo === 1);
  const crxIdFields = decodeFields(crxIdWrap.value);
  extIdFromHeader = crxIdFields.find((f) => f.fieldNo === 2).value.toString('utf8');
  check('signed_header_data 中含 32 字符扩展 ID',
    /^[a-p]{32}$/.test(extIdFromHeader), extIdFromHeader);
} catch (e) {
  check('protobuf 解析成功', false, e.message);
  process.exit(1);
}

section('签名与扩展 ID');
const derived = deriveExtensionId(pubDer);
check('从公钥派生的 ID 与 header 一致', derived === extIdFromHeader,
  `${derived} ≠ ${extIdFromHeader}`);
console.log(`        扩展 ID: ${derived}`);

const valid = crypto.verify(
  'sha256',
  Buffer.concat([Buffer.from(extIdFromHeader, 'utf8'), payload]),
  crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' }),
  sig
);
check('RSA 签名验证通过（覆盖 crx_id + zip）', valid);

section('内层 zip');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-'));
const zipPath = path.join(tmp, 'payload.zip');
fs.writeFileSync(zipPath, payload);
check('内层数据为合法 zip（PK\\x03\\x04）',
  payload[0] === 0x50 && payload[1] === 0x4b && payload[2] === 0x03 && payload[3] === 0x04,
  payload.subarray(0, 4).toString('hex'));

const unzipDir = path.join(tmp, 'ext');
execFileSync(PY, ['-c',
  `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zipPath, unzipDir],
  { stdio: 'inherit' });

check('解压后 manifest.json 在根目录', fs.existsSync(path.join(unzipDir, 'manifest.json')));

const mf = JSON.parse(fs.readFileSync(path.join(unzipDir, 'manifest.json'), 'utf8'));
check('manifest 版本与源一致', mf.version === JSON.parse(
  fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version, mf.version);
check('扩展名称为「搜索广告终结者」', mf.name === '搜索广告终结者', mf.name);

// 引用完整性
const refs = [
  mf.background.service_worker,
  ...mf.content_scripts[0].js,
  ...mf.content_scripts[0].css,
  mf.action.default_popup,
  ...Object.values(mf.action.default_icon || {}),
  ...Object.values(mf.content_scripts[0].icons || {})
];
const missing = refs.filter((r) => !fs.existsSync(path.join(unzipDir, r)));
check('包内引用文件齐备', missing.length === 0, missing.join(','));

// 开发文件不应进入
const leaked = [];
(function walk(d, base) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    const rel = path.relative(base, p).replace(/\\/g, '/');
    if (e.isDirectory()) walk(p, base);
    else if (rel.startsWith('test/') || rel.endsWith('.py')) leaked.push(rel);
  }
})(unzipDir, unzipDir);
check('无开发文件残留', leaked.length === 0, leaked.join(','));

section('包内功能验证（在 CRX 解压副本上跑测试）');
const srcTest = path.join(ROOT, 'test');
const dstTest = path.join(unzipDir, 'test');
fs.cpSync(srcTest, dstTest, { recursive: true });
for (const t of ['smoke.js', 'integration.js']) {
  let out = '';
  try {
    out = execFileSync(NODE, ['test/' + t], { cwd: unzipDir, encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const m = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/.exec(out);
  check(`${t} 在 CRX 解压副本上通过`,
    !!m && parseInt(m[2], 10) === 0,
    m ? `${m[1]} 项通过 / ${m[2]} 项失败` : '无输出');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(52));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);