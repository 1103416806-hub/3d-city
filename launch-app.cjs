const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const url = 'http://127.0.0.1:5178/';
const entry = path.join(__dirname, 'dist', 'index.html');
const browserCandidates = [
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

function reachable() {
  return new Promise(resolve => {
    const request = http.get(url, response => { response.resume(); resolve(response.statusCode === 200); });
    request.setTimeout(800, () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function main() {
  if (!fs.existsSync(entry)) throw new Error('缺少应用文件，请重新构建 3D 城市。');
  if (!await reachable()) {
    const server = spawn(process.execPath, ['--preserve-symlinks-main', path.join(__dirname, 'server.cjs')], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname,
    });
    server.unref();
    for (let i = 0; i < 40 && !await reachable(); i++) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!await reachable()) throw new Error('3D 城市服务没有成功启动。');
  const browser = browserCandidates.find(candidate => fs.existsSync(candidate));
  if (!browser) throw new Error('没有找到 Microsoft Edge 或 Google Chrome。');
  spawn(browser, [`--app=${url}`, '--start-maximized'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

main().catch(error => {
  const message = String(error.message).replaceAll("'", "''");
  spawn('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${message}', '3D城市启动失败')`], { windowsHide: true });
  process.exitCode = 1;
});
