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
