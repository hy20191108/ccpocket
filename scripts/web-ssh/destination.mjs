export function validateDestination(alias, port) {
  if (typeof alias !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(alias)) throw Error('Invalid OpenSSH host alias');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid Bridge port');
}

// The trust snapshot and SSH destination define the browser storage boundary.
// A replacement destination gets a new origin, including for already-open tabs.
export function destinationOrigin(identity) {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw Error('A frozen SSH trust identity is required');
  return `ccp-${identity.slice(0, 32)}.localhost`;
}
