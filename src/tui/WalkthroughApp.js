import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useApp, useStdout, useBoxMetrics } from 'ink';
import figlet from 'figlet';

/** Renders "Agentgateway" as ASCII-art lines, matching the CLI's own startup banner font. */
function renderAgentgatewayBanner() {
  return figlet
    .textSync('Agentgateway', { font: 'Standard', horizontalLayout: 'default' })
    .split('\n');
}

// padding: 1 on the root Box - 1 row top + 1 row bottom.
const ROOT_VERTICAL_PADDING = 2;

// The Response panel's own scroll viewport (independent of the page) - bounds a long
// response to a fixed number of visible lines instead of growing the whole row to match it.
const RESPONSE_PANEL_MAX_HEIGHT = 15;

/**
 * Renders a vertical scrollbar as one character per viewport row - a thumb sized to the visible
 * fraction of the content, positioned to match the current scroll offset.
 * @returns {?string[]} one character per row, or null when nothing needs to scroll
 */
export function renderScrollbar(viewportHeight, contentHeight, maxScroll, scrollOffset) {
  if (maxScroll <= 0 || !viewportHeight) return null;

  const thumbSize = Math.max(1, Math.round((viewportHeight * viewportHeight) / contentHeight));
  const maxThumbPosition = viewportHeight - thumbSize;
  const thumbPosition = Math.round((scrollOffset / maxScroll) * maxThumbPosition);

  return Array.from({ length: viewportHeight }, (_, i) =>
    i >= thumbPosition && i < thumbPosition + thumbSize ? '█' : '│'
  );
}

export function WalkthroughApp({ engine, installedVersion }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, forceRender] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [responseScrollOffset, setResponseScrollOffset] = useState(0);
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  // Raw, uncommitted keystrokes for a prompt step - only the submitted value crosses into the engine.
  const [promptBuffer, setPromptBuffer] = useState('');
  // Guards against a keypress starting a second step mid-flight (e.g. a double-pressed
  // right arrow during a multi-second browser-login wait) while the previous one still runs.
  const busyRef = useRef(false);
  // The alternate screen has no terminal-native scrollback (confirmed live: content taller than
  // the viewport is simply gone, not merely scrolled away) - this in-app viewport is a substitute.
  const contentRef = useRef(null);
  const headerRef = useRef(null);
  const footerRef = useRef(null);
  const responseBodyRef = useRef(null);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const { height: headerHeight } = useBoxMetrics(headerRef);
  const { height: footerHeight } = useBoxMetrics(footerRef);
  const { height: responseBodyHeight } = useBoxMetrics(responseBodyRef);

  useEffect(() => {
    const onChange = () => forceRender(n => n + 1);
    const onRunning = () => setRunning(true);
    engine.on('change', onChange);
    engine.on('running', onRunning);
    return () => {
      engine.off('change', onChange);
      engine.off('running', onRunning);
    };
  }, [engine]);

  // Ink already re-renders on terminal resize for its own layout - rereading stdout.rows here
  // each render keeps the footer pinned to the new bottom instead of the size at mount time.
  useEffect(() => {
    const onResize = () => forceRender(n => n + 1);
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  // A new screen or step has entirely different content - start scrolled to the top of it.
  useEffect(() => {
    setScrollOffset(0);
    setResponseScrollOffset(0);
  }, [engine.screenIndex, engine.stepIndex]);

  useEffect(() => {
    setPromptBuffer('');
  }, [engine.screenIndex, engine.stepIndex]);

  const viewportHeight = stdout.rows
    ? Math.max(0, stdout.rows - headerHeight - footerHeight - ROOT_VERTICAL_PADDING)
    : undefined;
  const maxScroll = viewportHeight === undefined ? 0 : Math.max(0, contentHeight - viewportHeight);
  const clampedScrollOffset = Math.min(scrollOffset, maxScroll);

  const responseMaxScroll = Math.max(0, responseBodyHeight - RESPONSE_PANEL_MAX_HEIGHT);
  const clampedResponseScrollOffset = Math.min(responseScrollOffset, responseMaxScroll);

  useInput((input, key) => {
    // The quit confirmation takes over every key until answered, even mid-prompt-entry,
    // so a presenter can't accidentally lose a walkthrough with a stray keystroke.
    if (confirmingQuit) {
      if (input.toLowerCase() === 'y' || key.return) {
        exit();
      } else {
        setConfirmingQuit(false);
      }
      return;
    }
    const currentStep = engine.currentStep;
    if (currentStep?.kind === 'prompt' && !engine.getStepResult()) {
      if (key.return) {
        engine.submitPromptValue(promptBuffer);
        return;
      }
      if (key.backspace || key.delete) {
        setPromptBuffer(buffer => buffer.slice(0, -1));
        return;
      }
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }
      if (
        input &&
        !key.escape &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      ) {
        setPromptBuffer(buffer => buffer + input);
      }
      return;
    }
    // ↑/↓ always scroll the whole page. w/s are dedicated to the Response panel's own bounded
    // viewport (RESPONSE_PANEL_MAX_HEIGHT) and scrollbar, so the two scrolls never fight over
    // the same keys - PageUp/PageDown are also wired to the same thing, but most Mac keyboards
    // have no such key at all.
    if (key.downArrow) {
      setScrollOffset(offset => Math.min(offset + 1, maxScroll));
      return;
    }
    if (key.upArrow) {
      setScrollOffset(offset => Math.max(offset - 1, 0));
      return;
    }
    if (key.pageDown || input.toLowerCase() === 's') {
      setResponseScrollOffset(offset => Math.min(offset + 1, responseMaxScroll));
      return;
    }
    if (key.pageUp || input.toLowerCase() === 'w') {
      setResponseScrollOffset(offset => Math.max(offset - 1, 0));
      return;
    }
    // q must be reachable even mid-operation (a stalled browser login or slow deploy shouldn't
    // trap the presenter behind ctrl+c) - every other key still waits for the current one to
    // finish. It only asks for confirmation rather than quitting outright.
    if (input === 'q') {
      setConfirmingQuit(true);
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    (async () => {
      try {
        setError(null);
        if (key.rightArrow) {
          await engine.handleRight();
        } else if (key.leftArrow) {
          await engine.handleLeft();
        } else if (/^[1-9]$/.test(input)) {
          await engine.jumpToScreen(Number(input) - 1);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setRunning(false);
        busyRef.current = false;
      }
    })();
  });

  const screen = engine.currentScreen;
  const step = engine.currentStep;
  const result = engine.getStepResult();
  const appliedYaml = engine.getAppliedYaml();
  const responseRevealed = engine.isResponseRevealed();

  const scrollbar = renderScrollbar(viewportHeight, contentHeight, maxScroll, clampedScrollOffset);

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      padding: 1,
      // minHeight (not height): a fixed height here would force Yoga to shrink/overlap
      // this Box's own children - it only pins the footer to the bottom when content is
      // short. The inner viewport Box below is where tall content actually gets clipped
      // and made scrollable, rather than overlapping or growing past the terminal.
      minHeight: stdout.rows || undefined,
    },
    installedVersion &&
      React.createElement(
        Box,
        {
          ref: headerRef,
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          marginBottom: 1,
          alignSelf: 'flex-start',
        },
        ...renderAgentgatewayBanner().map((line, i) =>
          React.createElement(Text, { key: i, bold: true, color: 'cyan' }, line)
        ),
        React.createElement(
          Box,
          { alignSelf: 'flex-end' },
          React.createElement(Text, { dimColor: true }, `version ${installedVersion}`)
        )
      ),
    React.createElement(
      Box,
      // No viewportHeight (non-TTY, e.g. tests) - just grow naturally, same as before scrolling existed.
      viewportHeight === undefined
        ? { flexDirection: 'row', flexGrow: 1 }
        : { flexDirection: 'row', height: viewportHeight },
      React.createElement(
        Box,
        viewportHeight === undefined
          ? { flexDirection: 'column', flexGrow: 1 }
          : {
              flexDirection: 'column',
              flexGrow: 1,
              overflowY: 'hidden',
              contentOffsetY: clampedScrollOffset,
            },
        React.createElement(
          Box,
          // flexShrink: 0 - Box defaults to flexShrink: 1, which would otherwise let Yoga shrink
          // this box to fit the viewport's fixed height instead of overflowing it, defeating both
          // the height measurement below and the point of clipping+scrolling it in the first place.
          { ref: contentRef, flexDirection: 'column', flexShrink: 0 },
          React.createElement(
            Text,
            { bold: true, underline: true, color: 'cyan' },
            `Lab ${engine.screenIndex + 1}/${engine.walkthrough.screens.length}: ${screen.title}`
          ),
          React.createElement(
            Box,
            { marginY: 1 },
            React.createElement(Text, null, screen.narration)
          ),
          step &&
            React.createElement(
              Box,
              { flexDirection: 'column', rowGap: 1 },
              React.createElement(
                Text,
                null,
                `📍 Step ${engine.stepIndex + 1}/${(screen.steps || []).length}: ${step.description || step.label}`
              ),
              React.createElement(Text, { bold: true }, `🚀 Executing Request: ${step.label}`)
            ),
          running &&
            React.createElement(
              Box,
              { marginY: 1 },
              React.createElement(Text, { color: 'yellow' }, 'Running...')
            ),
          error && React.createElement(Text, { color: 'red' }, `Error: ${error}`),
          step?.kind === 'prompt' &&
            !result &&
            React.createElement(
              Panel,
              { label: step.label || 'Input' },
              React.createElement(
                Text,
                null,
                (step.mask ? '•'.repeat(promptBuffer.length) : promptBuffer) + '█'
              )
            ),
          result &&
            React.createElement(StepResultView, {
              result,
              responseRevealed,
              responseScroll: {
                bodyRef: responseBodyRef,
                offset: clampedResponseScrollOffset,
                maxScroll: responseMaxScroll,
                bodyHeight: responseBodyHeight,
              },
            }),
          // Shown last, and only once the response has been revealed (or there's no step to
          // reveal at all, e.g. a narration-only screen) - the audience sees the live
          // request/response before the config that produced it, not alongside the request.
          appliedYaml &&
            (!step || responseRevealed) &&
            React.createElement(
              Panel,
              { label: 'What did we just apply?', borderColor: 'blue' },
              React.createElement(Text, { dimColor: true }, appliedYaml)
            )
        )
      ),
      scrollbar &&
        React.createElement(
          Box,
          { flexDirection: 'column', marginLeft: 1 },
          ...scrollbar.map((char, i) =>
            React.createElement(Text, { key: i, dimColor: char === '│' }, char)
          )
        )
    ),
    React.createElement(
      Box,
      {
        ref: footerRef,
        flexDirection: 'column',
        borderStyle: 'single',
        borderTop: true,
        borderBottom: false,
        borderLeft: false,
        borderRight: false,
        borderColor: 'gray',
        paddingTop: 1,
      },
      confirmingQuit
        ? React.createElement(
            Text,
            { bold: true, color: 'yellow' },
            '⚠ Quit the walkthrough? y to confirm · any other key to cancel'
          )
        : React.createElement(
            React.Fragment,
            null,
            maxScroll > 0 &&
              React.createElement(Text, { dimColor: true }, '↕ more content - scroll with ↑/↓'),
            responseMaxScroll > 0 &&
              React.createElement(
                Text,
                { dimColor: true },
                '⇞⇟ response has more - scroll with w/s'
              ),
            React.createElement(
              Text,
              { dimColor: true },
              step?.kind === 'prompt' && !result
                ? 'type your answer · enter submit · ctrl+c quit'
                : `← back · → ${result ? 'next' : 'run'} · 1-9 jump to screen · q quit`
            )
          )
    )
  );
}

const BODY_PREVIEW_LENGTH = 500;

/** Pretty-prints a response body as JSON when it parses as such, otherwise returns it unchanged. */
function formatBody(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Truncates a response body to a short preview, matching the design spec's "truncated body preview". */
function truncateBody(body) {
  const formatted = formatBody(body);
  return formatted.length > BODY_PREVIEW_LENGTH
    ? `${formatted.slice(0, BODY_PREVIEW_LENGTH)}...`
    : formatted;
}

/** The method/URL, headers, and (formatted) body of a request, as separate labeled sections. */
function RequestDetails({ request }) {
  const headerEntries = Object.entries(request.headers || {});
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, `${request.method} ${request.url}`),
    headerEntries.length > 0 &&
      React.createElement(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        React.createElement(Text, { dimColor: true, underline: true }, 'Headers'),
        ...headerEntries.map(([key, value]) =>
          React.createElement(Text, { key, dimColor: true }, `  ${key}: ${value}`)
        )
      ),
    request.body !== undefined &&
      React.createElement(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        React.createElement(Text, { dimColor: true, underline: true }, 'Body'),
        React.createElement(Text, null, truncateBody(request.body))
      )
  );
}

/** A bordered panel with a small dim label - the shared "square" frame for request/response/result content. */
function Panel({ label, borderColor, grow, children }) {
  const childList = Array.isArray(children) ? children : [children];
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: borderColor || 'gray',
      paddingX: 1,
      marginTop: 0,
      marginBottom: 1,
      flexGrow: grow ? 1 : undefined,
      flexBasis: grow ? 0 : undefined,
    },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { bold: true, underline: true, dimColor: true }, label)
    ),
    ...childList
  );
}

/**
 * Whether an HTTP status is a success (2xx) - drives the Response panel's color, independent
 * of whether it matched the step's expectStatus. A step deliberately expecting a 401 should
 * still show red: that's what a real client got, regardless of the walkthrough's narrative.
 */
export function isHttpSuccess(status) {
  return status >= 200 && status < 300;
}

/**
 * The Response panel's body. Always renders the full formatted body (never truncated) inside a
 * ref'd box so its true height can be measured; once that height exceeds
 * RESPONSE_PANEL_MAX_HEIGHT, wraps it in its own fixed-height scroll viewport and draws a
 * scrollbar alongside it - independent of the Request panel beside it and of the page's own
 * scroll.
 */
function ResponseBody({ body, scroll }) {
  const formatted = formatBody(body);
  const content = React.createElement(
    Box,
    { ref: scroll?.bodyRef, flexDirection: 'column', flexShrink: 0 },
    React.createElement(Text, { dimColor: true }, formatted)
  );

  if (!scroll || scroll.maxScroll <= 0) {
    return content;
  }

  const scrollbar = renderScrollbar(
    RESPONSE_PANEL_MAX_HEIGHT,
    scroll.bodyHeight,
    scroll.maxScroll,
    scroll.offset
  );
  return React.createElement(
    Box,
    { flexDirection: 'row', columnGap: 1 },
    React.createElement(
      Box,
      {
        flexDirection: 'column',
        height: RESPONSE_PANEL_MAX_HEIGHT,
        overflowY: 'hidden',
        contentOffsetY: scroll.offset,
        flexGrow: 1,
      },
      content
    ),
    scrollbar &&
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...scrollbar.map((char, i) =>
          React.createElement(Text, { key: i, dimColor: char === '│' }, char)
        )
      )
  );
}

function StepResultView({ result, responseRevealed, responseScroll }) {
  if (result.kind === 'http') {
    // A null status means the request never connected at all (e.g. a Gateway listener was
    // removed) - isHttpSuccess(null) is false, so this still colors red like any other failure.
    const statusColor = isHttpSuccess(result.status) ? 'green' : 'red';
    const statusLabel = result.status === null ? 'Connection failed' : `Status: ${result.status}`;
    return React.createElement(
      // Default (stretch) cross-axis alignment - Response is now height-capped at
      // RESPONSE_PANEL_MAX_HEIGHT, so stretching Request to match is a small, bounded pad
      // rather than the unbounded one a long, uncapped response used to cause.
      Box,
      { flexDirection: 'row', columnGap: 1 },
      React.createElement(
        Panel,
        { label: 'Request', grow: true },
        React.createElement(RequestDetails, { request: result.request })
      ),
      responseRevealed &&
        React.createElement(
          Panel,
          { label: 'Response', borderColor: statusColor, grow: true },
          React.createElement(Text, { color: statusColor }, statusLabel),
          result.expectResponseHeader &&
            React.createElement(
              Text,
              { dimColor: true },
              `${result.expectResponseHeader.name}: ${
                result.headers?.[result.expectResponseHeader.name.toLowerCase()] ?? '(missing)'
              }`
            ),
          result.body &&
            React.createElement(ResponseBody, { body: result.body, scroll: responseScroll })
        )
    );
  }
  if (result.kind === 'prompt') {
    const { value } = result;
    const shown = value.length > 4 ? `${'•'.repeat(value.length - 4)}${value.slice(-4)}` : value;
    return React.createElement(
      Panel,
      { label: 'Submitted', borderColor: 'green' },
      React.createElement(Text, { color: 'green' }, shown)
    );
  }
  if (result.kind === 'traffic-split') {
    return React.createElement(
      Box,
      { flexDirection: 'row', columnGap: 1 },
      React.createElement(
        Panel,
        { label: `Request (× ${result.requestCount})`, grow: true },
        React.createElement(RequestDetails, { request: result.request })
      ),
      React.createElement(
        Panel,
        { label: 'Traffic Split', grow: true },
        ...Object.entries(result.tally).map(([bucket, count]) =>
          React.createElement(Text, { key: bucket }, `${bucket}: ${count}/${result.requestCount}`)
        )
      )
    );
  }
  return null;
}
