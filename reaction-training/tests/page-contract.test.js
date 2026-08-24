const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const indexPath = path.join(projectRoot, 'index.html');
const stylesheetPath = path.join(projectRoot, 'assets', 'styles.css');
const needlePagePath = path.join(projectRoot, 'games', 'needle.html');
const molePagePath = path.join(projectRoot, 'games', 'whack-a-mole.html');
const numberClearPagePath = path.join(projectRoot, 'games', 'number-clear.html');

test('homepage provides the three reaction game entry links and shared styles', () => {
  const homepage = fs.readFileSync(indexPath, 'utf8');

  assert.match(homepage, /<title>反应训练台<\/title>/);
  assert.match(homepage, /href="games\/needle\.html"/);
  assert.match(homepage, /href="games\/whack-a-mole\.html"/);
  assert.match(homepage, /href="games\/number-clear\.html"/);
  assert.match(homepage, /见缝插针/);
  assert.match(homepage, /打地鼠/);
  assert.match(homepage, /数字消除/);
  assert.match(homepage, /assets\/styles\.css/);
});

test('shared styles define responsive and accessible console primitives', () => {
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');

  for (const customProperty of ['--ink', '--panel', '--signal', '--cyan']) {
    assert.match(stylesheet, new RegExp(customProperty));
  }

  for (const className of [
    'site-shell',
    'topbar',
    'game-grid',
    'game-card',
    'game-panel',
    'action-button',
    'choice-row',
    'status-line',
    'result-panel',
    'pulse-scale',
    'sr-only',
  ]) {
    assert.match(stylesheet, new RegExp(`\\.${className}`));
  }

  assert.match(stylesheet, /:focus-visible/);
  assert.match(stylesheet, /\.action-button:disabled/);
  assert.match(stylesheet, /\.action-button:not\(:disabled\):hover/);
  assert.match(stylesheet, /\.action-button\s*\{[^}]*border-radius:\s*\d+px/);
  assert.match(stylesheet, /\.action-button\s*\{[^}]*color:\s*#fff/);
  assert.match(stylesheet, /\.action-button\s*\{[^}]*text-align:\s*center/);
  assert.match(stylesheet, /\.action-button:not\(:disabled\):active/);
  assert.match(stylesheet, /\.action-button:focus-visible/);
  assert.match(stylesheet, /\.result-panel\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(stylesheet, /prefers-reduced-motion:\s*reduce/);
  assert.match(stylesheet, /@media\s*\(max-width:/);
});

test('primary action buttons use centered text without decorative symbols', () => {
  const pages = [indexPath, needlePagePath, molePagePath, numberClearPagePath]
    .map((pagePath) => fs.readFileSync(pagePath, 'utf8'));

  for (const page of pages) {
    assert.doesNotMatch(page, /class="action-button"[^>]*>[^<]*<span\s+aria-hidden="true"/);
  }
});

test('needle game page exposes its controls and loads its scripts in dependency order', () => {
  const needlePage = fs.readFileSync(needlePagePath, 'utf8');

  for (const id of [
    'needle-canvas',
    'needle-score',
    'needle-start',
    'needle-fire',
    'needle-result',
    'needle-replay',
    'needle-best-record',
    'needle-live',
  ]) {
    assert.match(needlePage, new RegExp(`id="${id}"`));
  }

  assert.match(needlePage, /assets\/styles\.css/);
  const scriptSources = Array.from(needlePage.matchAll(/<script\s+src="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(scriptSources, ['../assets/common.js', 'needle-core.js', 'needle.js']);
});

test('whack-a-mole page exposes its controls and loads its scripts in dependency order', () => {
  const molePage = fs.readFileSync(molePagePath, 'utf8');

  for (const id of [
    'mole-count',
    'mole-start',
    'mole-score',
    'mole-misses',
    'mole-field',
    'mole-result',
    'mole-replay',
    'mole-best-record',
    'mole-live',
  ]) {
    assert.match(molePage, new RegExp(`id="${id}"`));
  }

  for (const count of [6, 9, 12]) {
    assert.match(molePage, new RegExp(`<option\\s+value="${count}"`));
  }

  assert.match(molePage, /id="mole-field"[^>]*role="group"/);
  assert.match(molePage, /id="mole-field"[^>]*aria-describedby="mole-instructions"/);
  assert.match(molePage, /id="mole-feedback"/);
  assert.match(molePage, /id="mole-instructions"/);
  assert.match(molePage, /\.mole-field[^}]*height:\s*clamp\(300px,\s*calc\(100svh\s*-\s*326px\),\s*398px\)/);
  assert.match(molePage, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.mole-hole\s*\{[^}]*width:\s*48px[^}]*height:\s*36px/);
  assert.match(molePage, /assets\/styles\.css/);
  const scriptSources = Array.from(molePage.matchAll(/<script\s+src="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(scriptSources, ['../assets/common.js', 'whack-a-mole-core.js', 'whack-a-mole.js']);
});

test('shared styles use a light, compact training surface', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'assets', 'styles.css'), 'utf8');
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--ink:\s*#[ef]/i);
  assert.match(css, /min-height:\s*100svh/);
});

test('game pages use shared compact layout hooks instead of oversized inline headings', () => {
  const css = fs.readFileSync(stylesheetPath, 'utf8');
  const pages = [needlePagePath, molePagePath, numberClearPagePath].map((pagePath) => fs.readFileSync(pagePath, 'utf8'));

  assert.match(css, /\.game-page\s+\.site-shell/);
  assert.match(css, /\.game-page\s+\.game-panel/);
  assert.match(css, /\.game-title/);
  assert.match(css, /@media\s*\(min-width:\s*761px\)/);
  assert.match(css, /100svh/);

  for (const page of pages) {
    assert.match(page, /<body class="game-page">/);
    assert.match(page, /class="game-title"/);
    assert.doesNotMatch(page, /style="font-size:\s*clamp\(2\.25rem/);
  }

  assert.match(pages[0], /id="needle-canvas"[^>]*class="game-surface needle-canvas"/);
});

test('game surfaces and controls use the light palette', () => {
  const needlePage = fs.readFileSync(needlePagePath, 'utf8');
  const needleScript = fs.readFileSync(path.join(projectRoot, 'games', 'needle.js'), 'utf8');
  const molePage = fs.readFileSync(molePagePath, 'utf8');
  const numberPage = fs.readFileSync(numberClearPagePath, 'utf8');

  for (const source of [needleScript, molePage, numberPage]) {
    assert.doesNotMatch(source, /#071426|#0b2543|#12355b/i);
  }

  assert.match(needlePage, /\.needle-canvas/);
  assert.match(molePage, /\.mole-field[^}]*background:[^;}]*var\(--panel\)/);
  assert.match(molePage, /\.mole-hole[^}]*background:\s*#d9e4ec/i);
  assert.match(numberPage, /\.number-cell[^}]*background:\s*var\(--panel\)/);
  assert.match(numberPage, /\.number-cell[^}]*color:\s*var\(--paper\)/);
});

test('number clear page exposes accessible controls, supported orders, and dependencies', () => {
  const numberPage = fs.readFileSync(numberClearPagePath, 'utf8');

  for (const id of [
    'number-order',
    'number-start',
    'number-target',
    'number-time',
    'number-grid',
    'number-result',
    'number-replay',
    'number-best-record',
    'number-live',
  ]) {
    assert.match(numberPage, new RegExp(`id="${id}"`));
  }

  const optionValues = Array.from(numberPage.matchAll(/<option\s+value="(\d+)"/g), (match) => Number(match[1]));
  assert.deepEqual(optionValues, [4, 5, 6]);
  assert.match(numberPage, /assets\/styles\.css/);
  assert.match(numberPage, /id="number-grid"[^>]*role="group"/);
  assert.match(numberPage, /id="number-grid"[^>]*aria-describedby="number-instructions"/);
  assert.match(numberPage, /id="number-instructions"/);
  const scriptSources = Array.from(numberPage.matchAll(/<script\s+src="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(scriptSources, ['../assets/common.js', 'number-clear-core.js', 'number-clear.js']);
});

test('result panels expose best-record styling hooks', () => {
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');

  assert.match(stylesheet, /\.best-record\s*\{/);
  assert.match(stylesheet, /\.best-record\.is-new\s*\{/);
});
