/* eslint-disable react/no-unknown-property */
// Drop-in Perci window for the Apfel Harness.
// Copy to ~/opal/src/components/ApfelMode.jsx and register it like MarkItDownMode.
//
// The harness serves its own dark/light UI, so this wrapper only needs to:
//   1. health-check http://127.0.0.1:6271/api/health
//   2. embed the UI in a <webview> (desktop) or <iframe> (browser) with
//      ?theme=<resolvedTheme>&perci=1  — the harness reads both params.
//
// It does NOT need the postMessage vision bridge MarkItDownMode uses; apfel runs
// fully on-device and the harness talks to its own supervised apfel --serve.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { launchArgsFor } from '../lib/localServices';

const APFEL_URL = 'http://127.0.0.1:6271';

async function checkApfelStatus() {
    const response = await fetch(`${APFEL_URL}/api/health`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

export default function ApfelMode() {
    const { resolvedTheme } = useTheme();
    const canUseWebview = typeof window !== 'undefined' && Boolean(window.electron);
    const [frameKey, setFrameKey] = useState(0);
    const [status, setStatus] = useState({ state: 'loading' });
    const [contentReady, setContentReady] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [starting, setStarting] = useState(false);
    const webviewRef = useRef(null);
    const themedUrl = useMemo(() => `${APFEL_URL}/?theme=${resolvedTheme}&perci=1`, [resolvedTheme]);
    const canStart = Boolean(window.electron?.localhostStartNow) && Boolean(launchArgsFor('apfel-harness'));

    useEffect(() => {
        let active = true;
        setStatus({ state: 'loading' });
        setContentReady(false);
        setLoadError(null);
        checkApfelStatus()
            .then((result) => {
                if (!active) return;
                if (!result?.ok) throw new Error('Apfel Harness is not reachable.');
                // surface whether the on-device model itself is up, not just the UI server
                setStatus({ state: 'online', apfel: result.apfel?.state });
            })
            .catch((error) => {
                if (!active) return;
                setLoadError(error.message || 'Apfel Harness is not reachable.');
                setStatus({ state: 'offline' });
            });
        return () => { active = false; };
    }, [frameKey, themedUrl]);

    useEffect(() => {
        if (!canUseWebview) return undefined;
        const webview = webviewRef.current;
        if (!webview) return undefined;
        const onReady = () => { setContentReady(true); setLoadError(null); setStatus({ state: 'online' }); };
        const onFail = (event) => {
            if (!event.isMainFrame || event.errorCode === -3) return;
            setLoadError(event.errorDescription || `Failed to load (code ${event.errorCode})`);
            setStatus({ state: 'offline' });
        };
        webview.addEventListener('dom-ready', onReady);
        webview.addEventListener('did-fail-load', onFail);
        return () => {
            webview.removeEventListener('dom-ready', onReady);
            webview.removeEventListener('did-fail-load', onFail);
        };
    }, [canUseWebview, frameKey, themedUrl]);

    const reload = useCallback(() => { setLoadError(null); setContentReady(false); setFrameKey((k) => k + 1); }, []);
    const openExternal = useCallback(() => {
        if (window.electron?.openExternal) window.electron.openExternal(themedUrl);
        else window.open(themedUrl, '_blank', 'noopener,noreferrer');
    }, [themedUrl]);

    const startServer = useCallback(async () => {
        const launch = launchArgsFor('apfel-harness');
        if (!launch || !window.electron?.localhostStartNow) return;
        setStarting(true);
        setLoadError(null);
        try {
            const result = await window.electron.localhostStartNow(launch);
            if (!result?.ok) throw new Error(result?.error || 'Apfel Harness did not start.');
            const canProbe = Boolean(window.electron.localhostCheckHealth);
            for (let attempt = 0; attempt < 10; attempt += 1) {
                await new Promise((r) => setTimeout(r, 500));
                if (!canProbe) {
                    if (attempt >= 4) break;
                    continue;
                }
                const probe = await window.electron.localhostCheckHealth(APFEL_URL);
                if (probe?.ok) break;
            }
            reload();
        } catch (err) {
            setLoadError(err.message || 'Apfel Harness did not start.');
            setStatus({ state: 'offline' });
        } finally {
            setStarting(false);
        }
    }, [reload]);

    // Opening the Apfel window auto-starts its harness — one attempt per mount,
    // mirroring GithubOverviewMode. If the harness is missing (e.g. non-Mac or no checkout)
    // the error surfaces as the normal offline screen with a manual fallback.
    const autoStartedRef = useRef(false);
    useEffect(() => {
        if (status.state !== 'offline' || autoStartedRef.current || !canStart) return;
        autoStartedRef.current = true;
        startServer();
    }, [status.state, canStart, startServer]);

    const isOffline = status.state === 'offline' || Boolean(loadError);
    const isStarting = starting || status.state === 'loading';

    return (
        <div className="flex h-full flex-col bg-[var(--bg-primary)]">
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]">
                        <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                            <defs>
                                <linearGradient id="apple-rainbow-header" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#4DA64D"/>
                                    <stop offset="20%" stopColor="#E8B32A"/>
                                    <stop offset="40%" stopColor="#E07A2E"/>
                                    <stop offset="60%" stopColor="#D04545"/>
                                    <stop offset="80%" stopColor="#8E4E9A"/>
                                    <stop offset="100%" stopColor="#2E94C9"/>
                                </linearGradient>
                            </defs>
                            <circle cx="12" cy="14" r="8" fill="url(#apple-rainbow-header)"/>
                            <path d="M12 6.5c0-2.8 1.8-4 3.2-4.2" stroke="#4DA64D" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
                        </svg>
                    </div>
                    <div className="min-w-0">
                        <div className="truncate text-sm tracking-tight select-none">
                            <span className="bg-gradient-to-r from-[#4DA64D] via-[#E8B32A] via-[#E07A2E] via-[#D04545] via-[#8E4E9A] to-[#2E94C9] bg-clip-text text-transparent font-bold" style={{ fontWeight: 650 }}>
                                apfel
                            </span>
                            <span className="font-normal text-[var(--text-tertiary)]" style={{ fontWeight: 450 }}>
                                harness
                            </span>
                        </div>
                        <div className="truncate font-mono text-[11px] text-[var(--text-tertiary)]">{APFEL_URL}</div>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        status.state === 'online' ? 'bg-emerald-500/10 text-emerald-400'
                        : status.state === 'loading' ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
                        : 'bg-red-500/10 text-red-400'
                    }`}>
                        {status.state === 'online' ? (status.apfel === 'online' ? 'on-device' : 'ui only') : status.state}
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={reload} title="Reload"
                        className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                        <RefreshCw size={15} />
                    </button>
                    <button type="button" onClick={openExternal} title="Open in browser"
                        className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                        <ExternalLink size={15} />
                    </button>
                </div>
            </div>

            {isOffline ? (
                <div className="flex flex-1 items-center justify-center p-8">
                    <div className="max-w-md text-center">
                        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                            {isStarting ? 'Starting Apfel Harness…' : 'Apfel Harness is not running'}
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                            {canStart
                                ? 'Perci can launch the local harness (Apple Intelligence via apfel) for you. No terminal needed — just press Start.'
                                : 'The local harness wraps the apfel CLI (Apple Intelligence, on-device). Start it from ~/apfel-harness, then reload this window.'}
                        </p>
                        {!canStart && (
                            <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-xs text-[var(--text-secondary)]">
                                npm start
                            </div>
                        )}
                        <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                            {canStart
                                ? 'Runs ~6271 locally; apfel --serve on 6272 is supervised automatically.'
                                : 'Requires macOS on Apple Silicon with Apple Intelligence enabled. Fallback is manual: cd ~/apfel-harness && npm start.'}
                        </p>
                        {loadError && (
                            <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-red-400">
                                <AlertCircle size={13} /> {loadError}
                            </p>
                        )}
                        <div className="mt-5 flex justify-center gap-2">
                            {canStart && (
                                <button type="button" onClick={startServer} disabled={starting}
                                    className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60">
                                    {starting
                                        ? <><RefreshCw size={14} className="animate-spin" /> Starting…</>
                                        : <><Play size={14} /> Start Apfel Harness</>}
                                </button>
                            )}
                            <button type="button" onClick={reload}
                                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                                <RefreshCw size={14} /> Reload
                            </button>
                        </div>
                    </div>
                </div>
            ) : canUseWebview ? (
                <div className="relative min-h-0 flex-1">
                    <webview ref={webviewRef} key={`webview-${frameKey}-${resolvedTheme}`} src={themedUrl}
                        title="Apfel Harness" className="absolute inset-0 h-full w-full border-0" allowpopups="true" />
                    {!contentReady && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-primary)]/80 backdrop-blur-sm">
                            <div className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
                                <RefreshCw size={12} className="animate-spin" /> Loading Apfel…
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                <iframe key={`${frameKey}-${resolvedTheme}`} src={themedUrl} title="Apfel Harness"
                    className="min-h-0 flex-1 border-0" onLoad={() => { setContentReady(true); setStatus({ state: 'online' }); }} />
            )}
        </div>
    );
}
