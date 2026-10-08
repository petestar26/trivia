import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('./public/app-recovery.js', import.meta.url), 'utf8');
class Events {
  listeners = new Map();
  addEventListener(type, callback, options = {}) {
    const list = this.listeners.get(type) ?? [];
    list.push({ callback, once: options?.once });
    this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((x) => x.callback !== callback)
    );
  }
  emit(type, detail = {}) {
    for (const item of [...(this.listeners.get(type) ?? [])]) {
      item.callback({ type, target: this, ...detail });
      if (item.once) this.removeEventListener(type, item.callback);
    }
  }
  dispatchEvent(event) {
    this.emit(event.type);
    return true;
  }
}
class Element extends Events {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
  }
  children = [];
  style = {};
  attributes = {};
  get childElementCount() {
    return this.children.length;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  append(...elements) {
    for (const element of elements) {
      element.parent = this;
      this.children.push(element);
    }
  }
  remove() {
    this.parent.children = this.parent.children.filter((x) => x !== this);
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture({
  store = new Map(),
  blocked = false,
  offline = false,
  populated = false,
  loading = false,
  controller = null,
  getRegistration = async () => undefined,
} = {}) {
  const window = new Events();
  let reloads = 0;
  window.location = {
    reload: () => {
      reloads++;
    },
  };
  const root = new Element('div');
  root.id = 'root';
  if (populated) root.append(new Element('main'));
  const entry = new Element('script');
  entry.type = 'module';
  entry.src = '/assets/entry-v1.js';
  const document = Object.assign(new Events(), {
    readyState: loading ? 'loading' : 'complete',
    body: new Element('body'),
    getElementById: (id) =>
      id === 'root' ? root : document.body.children.find((x) => x.id === id),
    querySelector: () => entry,
    createElement: (tag) => new Element(tag),
  });
  const timers = new Map();
  let nextTimer = 0;
  let observer;
  const navigator = {
    onLine: !offline,
    serviceWorker: Object.assign(new Events(), { getRegistration, controller }),
  };
  vm.runInNewContext(script, {
    window,
    document,
    navigator,
    Event,
    sessionStorage: {
      getItem: (key) => {
        if (blocked) throw Error('blocked');
        return store.get(key);
      },
      setItem: (key, value) => {
        if (blocked) throw Error('blocked');
        store.set(key, value);
      },
      removeItem: (key) => {
        if (blocked) throw Error('blocked');
        store.delete(key);
      },
    },
    setTimeout: (fn, delay) => {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observer = this;
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  });
  return {
    window,
    document,
    navigator,
    root,
    entry,
    store,
    timers,
    get reloads() {
      return reloads;
    },
    panel: () => document.body.children.find((x) => x.id === 'app-recovery'),
    fail: () => window.emit('error', { target: entry }),
    render: () => {
      root.append(new Element('main'));
      if (!observer?.disconnected) observer?.callback();
    },
    advance: (delay) => {
      for (const [id, timer] of [...timers])
        if (timer.delay === delay) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}

test('failed entry gets one reload; a failed retry shows a usable recovery screen', async () => {
  const store = new Map();
  const first = fixture({ store });
  first.fail();
  first.fail();
  await flush();
  assert.equal(first.reloads, 1);
  const retry = fixture({ store });
  retry.fail();
  await flush();
  assert.equal(retry.reloads, 0);
  assert.equal(retry.panel().attributes.role, 'alert');
  const button = retry.panel().children[2];
  assert.equal(button.disabled, false);
  button.emit('click');
  await flush();
  assert.equal(retry.reloads, 1, 'an explicit user retry is still available');
});
test('offline or unavailable storage never creates an automatic reload loop', async () => {
  for (const options of [{ offline: true }, { blocked: true }]) {
    const f = fixture(options);
    f.fail();
    f.advance(30000);
    await flush();
    assert.equal(f.reloads, 0);
    assert.ok(f.panel());
    assert.equal(f.store.size, 0);
  }
});
test('offline recovery enables the button on reconnection without refreshing automatically', async () => {
  const f = fixture({ offline: true });
  f.fail();
  const button = f.panel().children[2];
  assert.equal(button.disabled, true);
  f.navigator.onLine = true;
  f.window.emit('online');
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(f.reloads, 0);
});
test('empty root watchdog retries once, while a late successful mount cancels it', async () => {
  const empty = fixture();
  empty.advance(30000);
  await flush();
  assert.equal(empty.reloads, 1);
  const late = fixture();
  late.render();
  late.advance(30000);
  await flush();
  assert.equal(late.reloads, 0);
  assert.equal(late.timers.size, 0);
});
test('successful bootstrap resets the recovery budget and ignores unrelated resource errors', async () => {
  const store = new Map([['playqube.app-recovery.v1', '1']]);
  const f = fixture({ store, populated: true });
  f.fail();
  f.window.emit('error', { target: new Element('img') });
  await flush();
  assert.equal(f.reloads, 0);
  assert.equal(store.size, 0);
  assert.equal(f.panel(), undefined);
});
test('error during head parsing waits for the body before showing recovery', async () => {
  const f = fixture({ loading: true });
  f.fail();
  await flush();
  assert.equal(f.reloads, 0);
  f.document.readyState = 'interactive';
  f.document.emit('DOMContentLoaded');
  await flush();
  assert.equal(f.reloads, 1);
});
test('a waiting update activates before the one automatic reload', async () => {
  const waiting = Object.assign(new Events(), { state: 'installed' });
  let messages = 0;
  waiting.postMessage = (message) => {
    assert.equal(message.type, 'SKIP_WAITING');
    messages++;
  };
  const f = fixture({ getRegistration: async () => ({ waiting }) });
  f.fail();
  await flush();
  assert.equal(messages, 1);
  assert.equal(f.reloads, 0);
  waiting.state = 'activated';
  waiting.emit('statechange');
  waiting.emit('statechange');
  await flush();
  assert.equal(f.reloads, 1);
  assert.equal(f.timers.size, 1, 'only the boot watchdog remains until navigation');
});
test('a controlled bootstrap waits for the updated controller, not only activation', async () => {
  const waiting = Object.assign(new Events(), { state: 'installed', postMessage() {} });
  const f = fixture({ controller: {}, getRegistration: async () => ({ waiting }) });
  f.fail();
  await flush();
  waiting.state = 'activated';
  waiting.emit('statechange');
  await flush();
  assert.equal(f.reloads, 0);
  f.navigator.serviceWorker.controller = {};
  f.navigator.serviceWorker.emit('controllerchange');
  await flush();
  assert.equal(f.reloads, 0, 'an unrelated controller must not acknowledge the requested update');
  f.navigator.serviceWorker.controller = waiting;
  f.navigator.serviceWorker.emit('controllerchange');
  await flush();
  assert.equal(f.reloads, 1);
});
test('an already activating or activated worker still requires control acknowledgement', async () => {
  for (const state of ['activating', 'activated']) {
    const active = Object.assign(new Events(), { state, postMessage() {} });
    const f = fixture({ controller: {}, getRegistration: async () => ({ active }) });
    f.fail();
    await flush();
    assert.equal(f.reloads, 0);
    active.state = 'activated';
    active.emit('statechange');
    await flush();
    assert.equal(f.reloads, 0);
    f.navigator.serviceWorker.controller = active;
    f.navigator.serviceWorker.emit('controllerchange');
    await flush();
    assert.equal(f.reloads, 1);
  }
});
test('registration lookup timeout leaves recovery usable and ignores late completion', async () => {
  let complete;
  const lookup = new Promise((resolve) => {
    complete = resolve;
  });
  const f = fixture({ getRegistration: () => lookup });
  f.fail();
  assert.ok(f.panel(), 'recovery is visible even during worker lookup');
  f.advance(10000);
  await flush();
  assert.equal(f.reloads, 0);
  assert.equal(f.panel().children[2].disabled, false);
  complete(undefined);
  await flush();
  assert.equal(f.reloads, 0);
});
test('activation timeout or failure does not reload later and still permits manual retry', async () => {
  for (const fail of ['timeout', 'redundant', 'post']) {
    const waiting = Object.assign(new Events(), { state: 'installed' });
    waiting.postMessage = () => {
      if (fail === 'post') throw Error('unavailable');
    };
    const f = fixture({ getRegistration: async () => ({ waiting }) });
    f.fail();
    await flush();
    if (fail === 'timeout') f.advance(10000);
    if (fail === 'redundant') {
      waiting.state = 'redundant';
      waiting.emit('statechange');
    }
    await flush();
    assert.equal(f.reloads, 0);
    assert.equal(f.panel().children[2].disabled, false);
    waiting.state = 'activated';
    waiting.emit('statechange');
    await flush();
    assert.equal(f.reloads, 0);
  }
});
test('late app rendering during recovery keeps the mounted UI and removes the native fallback', async () => {
  let complete;
  const lookup = new Promise((resolve) => {
    complete = resolve;
  });
  const f = fixture({ getRegistration: () => lookup });
  f.fail();
  f.render();
  complete(undefined);
  await flush();
  assert.equal(f.reloads, 0);
  assert.equal(f.panel(), undefined);
  assert.equal(f.store.size, 0);
  assert.equal(f.window.listeners.get('online').length, 0);
});
test('explicit retry still reloads after worker lookup or activation failures', async () => {
  for (const failure of ['rejection', 'lookup-timeout', 'activation-timeout', 'redundant']) {
    const waiting = Object.assign(new Events(), {
      state: failure === 'redundant' ? 'redundant' : 'installed',
      postMessage() {},
    });
    const getRegistration = () =>
      failure === 'rejection'
        ? Promise.reject(Error('blocked'))
        : failure === 'lookup-timeout'
          ? new Promise(() => {})
          : Promise.resolve({ waiting });
    const f = fixture({ getRegistration });
    f.fail();
    await flush();
    f.advance(10000);
    await flush();
    assert.equal(f.reloads, 0);
    const button = f.panel().children[2];
    assert.equal(button.disabled, false);
    button.emit('click');
    await flush();
    f.advance(10000);
    await flush();
    assert.equal(f.reloads, 1, `explicit retry must remain usable after ${failure}`);
  }
});
test('an app mounting during worker activation is preserved instead of automatically reloaded', async () => {
  const waiting = Object.assign(new Events(), { state: 'installed', postMessage() {} });
  const f = fixture({ getRegistration: async () => ({ waiting }) });
  f.fail();
  await flush();
  f.render();
  waiting.state = 'activated';
  waiting.emit('statechange');
  await flush();
  assert.equal(f.reloads, 0);
  assert.equal(f.panel(), undefined);
});
test('lazy preload failures notify a mounted app without auto-reloading or suppressing its boundary', async () => {
  const f = fixture({ populated: true });
  let notices = 0;
  let suppressed = 0;
  f.window.addEventListener('playqube:app-update-needed', () => notices++);
  f.window.emit('vite:preloadError', { preventDefault: () => suppressed++ });
  await flush();
  assert.equal(notices, 1);
  assert.equal(f.reloads, 0);
  assert.equal(suppressed, 0);
});

test('the recovery listener loads before the application entry module', async () => {
  const index = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(index.indexOf('/app-recovery.js') < index.indexOf('/src/main.tsx'));
});
