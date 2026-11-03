// Tests set the ACTUATE_* variables they need themselves. Remove the developer's own (a token or
// API URL exported in the shell), which the CLI prefers over saved credentials and would leak in.
for (const key of Object.keys(process.env)) if (key.startsWith("ACTUATE_")) delete process.env[key];
