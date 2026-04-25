import path from 'node:path';

// Sample JavaScript fixture.
class Greeter {
  constructor(prefix) {
    this.prefix = prefix;
  }

  greet(name) {
    return joinName(this.prefix, name);
  }
}

function joinName(prefix, name) {
  function normalize(value) {
    return value.trim().toUpperCase();
  }

  return `${prefix}:${normalize(name)}`;
}

const makeGreeting = (name) => joinName('hello', name);

export { Greeter, joinName, makeGreeting };

void path.sep;
