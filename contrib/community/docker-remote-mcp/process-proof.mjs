import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Reads process metadata without command arguments or environment values. */
function processes() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,stat=,comm='], { encoding: 'utf8' }).trim().split('\n').map((line) => {
    const [pid, ppid, ...fields] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), started: fields.slice(0, 5).join(' '), state: fields[5], name: fields.slice(6).join(' ') };
  });
}

/** Uses Linux start ticks where available; POSIX start time remains stable after reparenting or exec. */
function identity(row) {
  if (process.platform !== 'linux') return row.started;
  try {
    const fields = readFileSync('/proc/' + row.pid + '/stat', 'utf8').split(') ').at(-1).split(' ');
    return fields[19];
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error; }
}

/** Discovers only descendants owned by this proof before capturing their stable identities. */
export function ownedProcesses(rootPid = process.pid) {
  const rows = processes();
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  return rows.filter((row) => ids.has(row.pid) && row.pid !== rootPid && !row.name.endsWith('/ps') && row.name !== 'ps')
    .map((row) => ({ ...row, identity: identity(row) })).filter((row) => row.identity !== undefined);
}

/** Checks captured identities globally, including children now owned by init, without signalling any process. */
export function survivingProcesses(captured) {
  const current = new Map(processes().map((row) => [row.pid, row]));
  return captured.filter((old) => {
    const row = current.get(old.pid);
    return row !== undefined && identity(row) === old.identity;
  });
}
