import { test, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { EventEmitter } from 'node:events';
import { WalkthroughApp } from '../../src/tui/WalkthroughApp.js';

/**
 * A minimal stand-in for WalkthroughEngine's public surface - extend this with whatever
 * additional properties/methods WalkthroughApp.js reads as the component is implemented.
 */
function buildFakeEngine() {
  const engine = new EventEmitter();
  engine.walkthrough = {
    screens: [
      {
        name: 'one',
        title: 'Plain Setup',
        narration: 'A quick narration.',
        steps: [
          { kind: 'http', label: 'GET /health', method: 'GET', url: 'http://example.com/health' },
        ],
      },
    ],
  };
  engine.screenIndex = 0;
  engine.stepIndex = 0;
  engine.currentScreen = engine.walkthrough.screens[0];
  engine.currentStep = engine.currentScreen.steps[0];
  engine.getStepResult = () => null;
  engine.getAppliedYaml = () => null;
  engine.isResponseRevealed = () => false;
  return engine;
}

test("renders the first screen's title without throwing", () => {
  const engine = buildFakeEngine();
  const { lastFrame, unmount } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion: null })
  );
  expect(lastFrame()).toContain('Plain Setup');
  unmount();
});

// Ink parses a keypress and re-renders on the next tick, not synchronously within stdin.write().
function press(stdin, input) {
  stdin.write(input);
  return new Promise(resolve => setTimeout(resolve, 0));
}

test('pressing q asks for confirmation instead of quitting immediately', async () => {
  const engine = buildFakeEngine();
  const { lastFrame, stdin, unmount } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion: null })
  );

  await press(stdin, 'q');

  expect(lastFrame()).toContain('Quit the walkthrough?');
  unmount();
});

test('any key other than y cancels the quit confirmation', async () => {
  const engine = buildFakeEngine();
  const { lastFrame, stdin, unmount } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion: null })
  );

  await press(stdin, 'q');
  expect(lastFrame()).toContain('Quit the walkthrough?');

  await press(stdin, 'n');
  expect(lastFrame()).not.toContain('Quit the walkthrough?');
  expect(lastFrame()).toContain('q quit');

  unmount();
});

test('confirming with y stops the app from reacting to further keys', async () => {
  const engine = buildFakeEngine();
  let rightPresses = 0;
  engine.handleRight = async () => {
    rightPresses += 1;
  };
  const { stdin, unmount } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion: null })
  );

  await press(stdin, 'q');
  await press(stdin, 'y');
  await press(stdin, '\u001B[C'); // right arrow

  expect(rightPresses).toBe(0);
  unmount();
});

test('a traffic-split result shows the request that was fired alongside the tally', () => {
  const engine = buildFakeEngine();
  engine.currentScreen.steps[0] = {
    kind: 'traffic-split',
    label: '20 requests',
    method: 'POST',
    url: 'http://example.com/model',
  };
  engine.currentStep = engine.currentScreen.steps[0];
  engine.getStepResult = () => ({
    kind: 'traffic-split',
    request: { method: 'POST', url: 'http://example.com/model', headers: {} },
    tally: { 'gpt-4o-mini': 17, 'gemini-2.5-flash': 3 },
    requestCount: 20,
  });
  engine.isResponseRevealed = () => true;

  const { lastFrame, unmount } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion: null })
  );

  const frame = lastFrame();
  expect(frame).toContain('Request (× 20)');
  expect(frame).toContain('POST http://example.com/model');
  expect(frame).toContain('Traffic Split');
  expect(frame).toContain('gpt-4o-mini: 17/20');
  unmount();
});

test('a previewed traffic-split step shows only the request, not yet the tally', () => {
  const engine = buildFakeEngine();
  engine.currentScreen.steps[0] = {
    kind: 'traffic-split',
    label: '20 requests',
    method: 'POST',
    url: 'http://example.com/model',
  };
  engine.currentStep = engine.currentScreen.steps[0];
  engine.getStepResult = () => ({
    kind: 'traffic-split',
    request: { method: 'POST', url: 'http://example.com/model', headers: {} },
    requestCount: 20,
  });
  engine.isResponseRevealed = () => false;

  const { lastFrame, unmount } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion: null })
  );

  const frame = lastFrame();
  expect(frame).toContain('Request (× 20)');
  expect(frame).toContain('POST http://example.com/model');
  expect(frame).not.toContain('Traffic Split');
  unmount();
});
