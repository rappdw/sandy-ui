// Hostile sample content the approval modal must display verbatim.
// Includes characters at risk of HTML-encoding (`<`, `&`, `"`, `'`),
// special chars in keys/values, and leading whitespace.
export const HOSTILE_KEYVALUES = [
  `SANDY_SKIP_PERMISSIONS=1`,
  `SANDY_ALLOW_LAN_HOSTS=10.0.0.0/24,192.168.1.0/24`,
  `SANDY_AGENT=claude,codex`,
  `SANDY_CUSTOM=<script>alert(1)</script>&foo="bar"`,
  `SANDY_INDENTED=  spaces matter  `,
  `SANDY_QUOTED='single' "double"`,
].join("\n");

export const HEADER = "Sandy: passive-privileged approval requested";
export const SUBTEXT = "The following privileged keys are set in the workspace .sandy/config and require explicit approval before sandy will use them.";
