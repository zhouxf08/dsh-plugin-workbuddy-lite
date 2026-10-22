#!/bin/sh
# Install this plugin tarball into the DSH web profile.
#
# Usage:
#   ./install.sh                 # install the tarball in this directory
#   ./install.sh /path/to.tgz    # install a specific tarball
#
# After installation, fully quit DSH (⌘Q) and reopen it.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARBALL=${1:-"$DIR/dsh-plugin-workbuddy-lite-0.1.6.tgz"}
PROFILE=${DSH_INSTALL_PROFILE:-web}

if [ ! -f "$TARBALL" ]; then
  echo "找不到 tarball：$TARBALL" >&2
  echo "请先在插件目录执行 npm pack。" >&2
  exit 1
fi

if command -v dsh >/dev/null 2>&1; then
  exec dsh plugin --profile "$PROFILE" add "$TARBALL"
fi

# 终端没有 dsh 命令时，用 DSH.app 自带的 Electron 以 Node 模式运行 CLI。
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ -x "$APP" ] && [ -f "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" ]; then
  ELECTRON_RUN_AS_NODE=1 "$APP" "$CLI" plugin --profile "$PROFILE" add "$TARBALL"
  exit $?
fi

echo "未找到 dsh 命令或 DeepSeek Harness.app。" >&2
echo "请在 DSH 侧边栏 Plugins → Add plugin 中填入：" >&2
echo "  $TARBALL" >&2
exit 1
