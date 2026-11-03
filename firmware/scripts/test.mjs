import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.pio', 'harness');
mkdirSync(out, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsVerbatimArguments: command === 'cmd.exe' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.platform === 'win32') {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const result = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
  const vcvars = path.join(result.stdout?.trim() ?? '', 'VC/Auxiliary/Build/vcvars64.bat');
  if (!existsSync(vcvars)) throw new Error('Install Visual Studio C++ Build Tools to run the desktop harness.');
  run('cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" >nul && cl /nologo /std:c++17 /EHsc /W4 /WX /D_CRT_SECURE_NO_WARNINGS /I"${path.join(root, 'include')}" "${path.join(root, 'test/setup_test.cpp')}" /Fe:setup_test.exe /Fo:setup_test.obj"`], out);
  run(path.join(out, 'setup_test.exe'), [], out);
} else {
  const executable = path.join(out, 'setup_test');
  run(process.env.CXX ?? 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-Iinclude', 'test/setup_test.cpp', '-o', executable]);
  run(executable, [], out);
}

