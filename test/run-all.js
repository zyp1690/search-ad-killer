/**
 * run-all.js —— 统一测试入口
 * 运行：node test/run-all.js
 *
 * 两套测试的分工：
 *   smoke.js       单元测试：规则库、配置迁移、站点识别、content.js 清理行为
 *   integration.js 集成测试：真实执行 options/popup/background/content 四个模块，
 *                  覆盖渲染、交互、消息通信与统计链路
 */
const { execFileSync } = require('child_process');
const path = require('path');

const files = ['smoke.js', 'integration.js'];
let failed = 0;
let totalPass = 0;
let totalFail = 0;

for (const f of files) {
  console.log('\n' + '#'.repeat(56));
  console.log('#  ' + f);
  console.log('#'.repeat(56));
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, f)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    failed++;
  }
  process.stdout.write(out);

  // 解析通过/失败数
  const pm = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/.exec(out);
  if (pm) {
    totalPass += parseInt(pm[1], 10);
    totalFail += parseInt(pm[2], 10);
  }
}

console.log('\n' + '='.repeat(56));
console.log(`  合计：通过 ${totalPass} 项，失败 ${totalFail} 项`);
if (failed) console.log(`  有 ${failed} 个测试文件执行异常`);
console.log('='.repeat(56));
process.exit(totalFail > 0 || failed > 0 ? 1 : 0);