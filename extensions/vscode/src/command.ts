import * as path from "node:path";

export function expandCommand(
  command: string,
  source: string,
  outputName: string,
  buildDir: string,
  className = path.parse(source).name,
  platform: NodeJS.Platform = process.platform
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  // Expand compound output tokens first. Otherwise `{output}.exe` can become
  // `"C:\path with spaces\name".exe`, which cmd.exe splits and MinGW rejects.
  const executable = platform === "win32"
    ? quoteShellPath(platformPath.join(buildDir, `${outputName}.exe`), platform)
    : `${outputName}.exe`;

  return command
    .replaceAll("{output}.jar", `${outputName}.jar`)
    .replaceAll("{output}.exe", executable)
    .replaceAll("{source}", quoteShellPath(source, platform))
    .replaceAll("{output}", outputName)
    .replaceAll("{dir}", quoteShellPath(buildDir, platform))
    .replaceAll("{classname}", outputName === className ? outputName : quoteShellPath(className, platform));
}

/** Quote filesystem paths for the selected platform shell. */
export function quoteShellPath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // cmd.exe + MinGW/Python: quote the whole argument only when necessary.
    if (!/[\s"&|<>^()]/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
