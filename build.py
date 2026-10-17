#!/usr/bin/env python3
"""
build.py —— 扩展打包脚本

产出：
  dist/search-ad-killer-v<版本>.zip    可上传 Edge/Chrome 商店
  dist/搜索广告终结者-v<版本>-已解压/    免解压目录，可直接被浏览器加载

打包规则：
  · manifest.json 必须位于压缩包根目录（浏览器要求）
  · 排除开发专用文件（test/、图标生成脚本、README）
  · 保留完整目录结构（../shared/ 等相对引用依赖它）
  · 压缩包内文件名统一用正斜杠（Windows 下 zip 默认反斜杠会导致加载失败）

用法：
  python build.py            # 正常打包
  python build.py --verify   # 打包后额外做完整性校验
"""

import json
import os
import sys
import zipfile
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, 'dist')

# 不进包的目录（开发工具，浏览器不需要）
EXCLUDE_DIRS = {'test', 'dist', '__pycache__', '.git', '.idea', '.vscode'}

# 不进包的文件（开发工具，浏览器不需要）
EXCLUDE_FILES = {
    'make_icons.py',      # 图标生成脚本
    'build.py',           # 打包脚本自身
    'build-crx.js',       # CRX 打包脚本
    'verify-crx.js',      # CRX 校验脚本
    'README.md',          # 开发文档（另附安装说明）
    'INSTALL.md',         # 仓库用安装文档（包内另有「安装说明.txt」）
    'LICENSE',            # 许可证（包内说明已含 MIT 标注）
    '.crx-key.pem',       # 签名私钥，严禁外泄
    '.DS_Store',
    'Thumbs.db',
}
EXCLUDE_EXT = {'.pyc', '.pyo', '.log', '.tmp', '.bak', '.swp'}

INSTALL_GUIDE = """搜索广告终结者 · 安装说明
════════════════════════════════════════════════════════════

  版本   3.5.0
  作者   火舞狂沙
  仓库   https://github.com/zyp1690/search-ad-killer
  许可   MIT License

精准去除百度、360、搜狗、必应、Google、DuckDuckGo 六大搜索引擎结果中的推广广告。


【方案 A】CRX 一键安装（Chrome 推荐，一步到位）
════════════════════════════════════════════════════════════

1. 把 .crx 文件放到桌面等方便的位置
2. 打开 chrome://extensions/（Edge 用 edge://extensions/）
3. 开启「开发者模式」
4. 把 .crx 文件直接拖进浏览器窗口
5. 弹窗确认后点「添加扩展」


【方案 B】免解压目录（Edge 推荐，最稳定）
════════════════════════════════════════════════════════════

1. 打开 edge://extensions/（Chrome 用 chrome://extensions/）
2. 开启左下角「开发人员模式」
3. 点击「加载解压缩的扩展」
4. 选择含 manifest.json 的那一层文件夹

本压缩包内已附带解压好的文件夹，可直接使用，无需自己解压。


【若 CRX 拖拽被拦截】
════════════════════════════════════════════════════════════

Edge 常报「程序包无效」或 CRX_REQUIRED_PROOF_MISSING。
这是 Edge 对非商店扩展的安全策略，与文件无关 —— 改用方案 B 即可。


【验证安装成功】
  · 扩展列表中出现「搜索广告终结者」
  · 工具栏出现盾牌图标
  · 首次安装会自动打开设置页
  · 访问 https://www.baidu.com/s?wd=test ，推广结果应已消失


【以后更新】
  替换文件后在扩展卡片上点「刷新」即可，不必重新加载。
  配置保存在浏览器本地，刷新不会丢失。


支持的搜索引擎
════════════════════════════════════════════════════════════

  百度        www.baidu.com / m.baidu.com      默认开启
  360 搜索    www.so.com / m.so.com            默认开启
  搜狗搜索    www.sogou.com                     默认开启
  必应        www.bing.com / cn.bing.com        默认开启
  Google      www.google.com                    默认关闭
  DuckDuckGo  duckduckgo.com                    默认关闭

Google 默认关闭因其广告标记依赖英文文案，中文语境易误伤；
DuckDuckGo 因国内访问稳定性默认关闭。需要时在设置页打开开关即可。

图片、地图、资讯、视频等子站不处理，避免误伤正常内容。


权限与隐私
════════════════════════════════════════════════════════════

  storage    仅用于保存你的开关配置
  activeTab  仅在点击扩展图标时与当前标签页通信

不读取浏览历史，不收集、不上传任何数据，所有配置仅保存在本地浏览器中。


问题反馈
════════════════════════════════════════════════════════════

  https://github.com/zyp1690/search-ad-killer/issues

════════════════════════════════════════════════════════════

  搜索广告终结者 v3.5.0
  作者 火舞狂沙 · https://github.com/zyp1690
  MIT License
"""


def read_version():
    with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
        return json.load(f).get('version', '0.0.0')


def read_name():
    with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
        m = json.load(f)
    return m.get('short_name') or m.get('name', 'extension')


def collect_files():
    """收集需要打包的文件，返回 [(绝对路径, 包内相对路径)]"""
    items = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        # 原地过滤排除目录，避免无谓递归
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith('.')]

        for fn in filenames:
            if fn in EXCLUDE_FILES or fn.startswith('.'):
                continue
            if os.path.splitext(fn)[1].lower() in EXCLUDE_EXT:
                continue

            abs_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(abs_path, ROOT).replace(os.sep, '/')
            items.append((abs_path, rel))
    return sorted(items, key=lambda x: x[1])


def required_files():
    """manifest.json 中引用到的文件，必须全部存在，否则浏览器加载会失败"""
    with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
        m = json.load(f)

    refs = []
    if 'background' in m:
        refs.append(m['background']['service_worker'])
    for cs in m.get('content_scripts', []):
        refs += cs.get('js', [])
        refs += cs.get('css', [])
    act = m.get('action', {})
    if act.get('default_popup'):
        refs.append(act['default_popup'])
    refs += list(act.get('default_icon', {}).values())
    if m.get('options_page'):
        refs.append(m['options_page'])
    elif m.get('options_ui', {}).get('page'):
        refs.append(m['options_ui']['page'])

    # HTML 内部还有 CSS/JS 引用，一并收集
    for page in ('options/options.html', 'popup/popup.html'):
        p = os.path.join(ROOT, page)
        if not os.path.isfile(p):
            continue
        with open(p, encoding='utf-8') as f:
            html = f.read()
        import re
        for m2 in re.finditer(r'(?:src|href)="([^"]+)"', html):
            ref = m2.group(1)
            if ref.startswith(('http://', 'https://', 'data:', '#')):
                continue
            full = os.path.normpath(os.path.join(ROOT, os.path.dirname(page), ref))
            if os.path.isfile(full):
                refs.append(os.path.relpath(full, ROOT).replace(os.sep, '/'))

    return sorted(set(refs))


def build():
    version = read_version()
    name = read_name()
    os.makedirs(DIST, exist_ok=True)

    zip_name = f'search-ad-killer-v{version}.zip'
    zip_path = os.path.join(DIST, zip_name)
    folder_name = f'搜索广告终结者-v{version}-已解压'
    folder_path = os.path.join(DIST, folder_name)

    files = collect_files()
    refs = required_files()

    print(f'扩展      : {name} v{version}')
    print(f'待打包文件: {len(files)} 个')
    print(f'输出      : dist/{zip_name}\n')

    # 打包前的引用完整性检查
    missing = [r for r in refs if not os.path.isfile(os.path.join(ROOT, r))]
    if missing:
        print('[错误] manifest/HTML 引用的文件缺失：')
        for x in missing:
            print('   -', x)
        return None
    print('[校验] 所有引用文件齐备')

    # ---- 产出 1：zip 包（含安装说明）----
    if os.path.exists(zip_path):
        os.remove(zip_path)

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for abs_path, rel in files:
            # arcname 用正斜杠，保证跨平台解压后结构正确
            zf.write(abs_path, rel)
        zf.writestr('安装说明.txt', INSTALL_GUIDE)

    # ---- 产出 2：免解压目录（可直接被浏览器加载）----
    import shutil
    if os.path.exists(folder_path):
        shutil.rmtree(folder_path)
    for abs_path, rel in files:
        dst = os.path.join(folder_path, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(abs_path, dst)
    with open(os.path.join(folder_path, '安装说明.txt'), 'w', encoding='utf-8') as f:
        f.write(INSTALL_GUIDE)

    size_kb = os.path.getsize(zip_path) / 1024
    print(f'[完成] {zip_name}  ({size_kb:.1f} KB)')
    print(f'[完成] {folder_name}/  (可直接加载，免解压)')

    # ---- 产出 3：CRX 安装包（可选，失败不影响前两项）----
    crx_note = ''
    if not os.environ.get('BADC_SKIP_CRX'):
        try:
            import subprocess
            node = os.environ.get('BADC_NODE') or 'node'
            subprocess.run([node, os.path.join(ROOT, 'build-crx.js')], cwd=ROOT,
                           check=True, capture_output=True)
            crx_path = os.path.join(DIST, f'search-ad-killer-v{version}.crx')
            if os.path.isfile(crx_path):
                crx_note = f'\n[完成] search-ad-killer-v{version}.crx  ' \
                           f'({os.path.getsize(crx_path) / 1024:.1f} KB，拖入浏览器即可安装)'
        except Exception:
            crx_note = '\n[跳过] CRX 未生成（需 Node 环境，不影响上面两项）'

    return zip_path, folder_path, crx_note


def verify(zip_path, folder_path):
    """解压到临时目录，模拟浏览器检查包结构"""
    import tempfile

    print('\n=== 打包校验 ===')
    ok = True

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()

        # 1. 根目录必须有 manifest.json
        if 'manifest.json' in names:
            print('[OK] manifest.json 位于根目录')
        else:
            print('[错误] manifest.json 不在根目录，浏览器无法加载')
            ok = False

        # 2. 路径分隔符必须是正斜杠
        bad = [n for n in names if '\\' in n]
        if bad:
            print('[错误] 存在反斜杠路径：', bad[:3])
            ok = False
        else:
            print('[OK] 路径分隔符正确')

        # 3. 不得包含排除项
        clean = True
        for kw in ('test/', 'make_icons.py', 'build.py', 'README.md'):
            hit = [n for n in names if n.startswith(kw) or '/' + kw in n]
            if hit:
                print(f'[错误] 包含应排除的文件：{kw} → {hit[:2]}')
                ok = False
                clean = False
        if clean:
            print('[OK] 无开发文件残留')

        # 4. 安装说明已包含
        if '安装说明.txt' in names:
            print('[OK] 安装说明已包含')
        else:
            print('[错误] 缺少安装说明.txt')
            ok = False

        # 5. 解压后所有引用文件应存在
        with tempfile.TemporaryDirectory() as tmp:
            zf.extractall(tmp)
            miss = []
            for ref in required_files():
                if not os.path.isfile(os.path.join(tmp, ref.replace('/', os.sep))):
                    miss.append(ref)
            if miss:
                print('[错误] 解压后缺失文件：', miss)
                ok = False
            else:
                print('[OK] 解压后引用完整')

            # 6. manifest JSON 可解析
            try:
                with open(os.path.join(tmp, 'manifest.json'), encoding='utf-8') as f:
                    json.load(f)
                print('[OK] manifest.json 格式有效')
            except Exception as e:
                print('[错误] manifest 解析失败：', e)
                ok = False

    # 7. 免解压目录检查
    if folder_path:
        if os.path.isfile(os.path.join(folder_path, 'manifest.json')):
            print('[OK] 免解压目录含 manifest.json')
        else:
            print('[错误] 免解压目录结构不完整')
            ok = False
        fmiss = [r for r in required_files()
                 if not os.path.isfile(os.path.join(folder_path, r.replace('/', os.sep)))]
        if fmiss:
            print('[错误] 免解压目录缺失：', fmiss)
            ok = False
        else:
            print('[OK] 免解压目录引用完整')

    # 8. 文件清单
    with zipfile.ZipFile(zip_path) as zf:
        print(f'\n包内文件（{len(zf.namelist())} 个）：')
        for n in sorted(zf.namelist()):
            print('   ', n)

    print('\n' + ('[校验通过] 可直接加载使用' if ok else '[校验失败] 请修复上述问题'))
    return ok


if __name__ == '__main__':
    result = build()
    if result is None:
        sys.exit(1)
    zp, fp, crx_note = result
    print(crx_note)
    if '--verify' in sys.argv:
        sys.exit(0 if verify(zp, fp) else 1)
    print('\n提示：Chrome 可把 dist/ 下的 .crx 直接拖入 chrome://extensions/ 安装；')
    print('      Edge 请用 dist/ 下的免解压目录（见其中「安装说明.txt」）。')