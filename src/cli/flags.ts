/**
 * Parse CLI flags into a string map. Value flags consume the next argument;
 * boolean flags (--resume without a value, --help, --auto) are set to '1'.
 */
export function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') flags.provider = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--base-url') flags.baseUrl = argv[++i];
    else if (a === '--resume') {
      const next = argv[i + 1];
      flags.resume = next && !next.startsWith('-') ? argv[++i] : '1';
    }
    else if (a === '--help') flags.help = '1';
    else if (a === '--auto') flags.auto = '1';
  }
  return flags;
}
