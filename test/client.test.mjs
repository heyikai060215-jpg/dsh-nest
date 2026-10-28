import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/**
 * 宿主里没有独立的 react 包（客户端运行时自带），测试里给一个够用的替身：
 * 只保证模块顶层解构得出来，组件本身不会被真正渲染。
 */
const ReactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (factory) => factory(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
};

/**
 * 把 client.js 当浏览器里的自注册脚本执行，拿到它交给 __ModuleLoader__ 的定义。
 * @returns {{id: string, factory: Function}} 模块定义
 */
function loadClientModule() {
  const source = fs.readFileSync(clientPath, 'utf8');
  let captured;
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };
  // 和浏览器里一样：脚本顶层只碰 window。
  new Function('window', source)(fakeWindow);
  assert.ok(captured, 'client.js 应该调用 window.__ModuleLoader__.load');
  return captured;
}

test('client.js 用包名注册，并交给宿主一个 factory', () => {
  const definition = loadClientModule();
  assert.equal(definition.id, 'dsh-nest');
  assert.equal(typeof definition.factory, 'function');
});

test('factory 返回 inject/apply，apply 把面板挂进 settings.section', () => {
  const definition = loadClientModule();
  const module = definition.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  });

  assert.deepEqual(module.inject, ['slots']);
  assert.equal(typeof module.apply, 'function');

  const registered = [];
  const slots = {
    inject(name, factory) {
      assert.equal(name, 'settings.section');
      factory();
    },
    register(meta, component) {
      registered.push({ meta, component });
      return () => undefined;
    },
  };
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  };
  module.apply(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].meta.name, 'settings.section');
  assert.equal(registered[0].meta.id, 'nest-relations');
  assert.equal(registered[0].meta.label, '会话从属');
  assert.equal(typeof registered[0].component, 'function');
});
