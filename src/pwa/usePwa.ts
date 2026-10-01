import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export type PwaInstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface PwaState {
  canInstall: boolean;
  isInstalled: boolean;
  manualInstallHint: boolean;
  offlineReady: boolean;
  updateAvailable: boolean;
  online: boolean;
  registrationError: string | null;
}

export interface PwaControls extends PwaState {
  install: () => Promise<PwaInstallOutcome>;
  update: () => Promise<boolean>;
}

type PwaListener = () => void;

const listeners = new Set<PwaListener>();
let pendingInstallPrompt: BeforeInstallPromptEvent | null = null;
let currentRegistration: ServiceWorkerRegistration | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;

  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

function shouldShowManualInstallHint(): boolean {
  if (typeof navigator === "undefined" || isStandalone()) return false;

  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return appleMobile || touchMac;
}

let snapshot: PwaState = {
  canInstall: false,
  isInstalled: isStandalone(),
  manualInstallHint: shouldShowManualInstallHint(),
  offlineReady: false,
  updateAvailable: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  registrationError: null,
};

function publish(patch: Partial<PwaState>): void {
  const next = { ...snapshot, ...patch };
  if (Object.keys(patch).every((key) => next[key as keyof PwaState] === snapshot[key as keyof PwaState])) {
    return;
  }

  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: PwaListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PwaState {
  return snapshot;
}

function watchInstallingWorker(
  worker: ServiceWorker,
  registration: ServiceWorkerRegistration,
): void {
  worker.addEventListener("statechange", () => {
    if (worker.state !== "installed") return;

    if (navigator.serviceWorker.controller) {
      publish({ updateAvailable: true });
      currentRegistration = registration;
    } else {
      publish({ offlineReady: true });
    }
  });
}

function attachBrowserEvents(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingInstallPrompt = event as BeforeInstallPromptEvent;
    publish({ canInstall: true, manualInstallHint: false });
  });

  window.addEventListener("appinstalled", () => {
    pendingInstallPrompt = null;
    publish({ canInstall: false, isInstalled: true, manualInstallHint: false });
  });

  window.addEventListener("online", () => publish({ online: true }));
  window.addEventListener("offline", () => publish({ online: false }));

  const standaloneQuery = window.matchMedia("(display-mode: standalone)");
  standaloneQuery.addEventListener("change", () => {
    const installed = isStandalone();
    publish({
      isInstalled: installed,
      manualInstallHint: installed ? false : shouldShowManualInstallHint(),
    });
  });
}

async function waitForWindowLoad(): Promise<void> {
  if (document.readyState === "complete") return;
  await new Promise<void>((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
}

export function registerPwa(): Promise<ServiceWorkerRegistration | null> {
  if (registrationPromise) return registrationPromise;

  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) {
    registrationPromise = Promise.resolve(null);
    return registrationPromise;
  }

  attachBrowserEvents();
  registrationPromise = (async () => {
    try {
      await waitForWindowLoad();

      const workerUrl = new URL("sw.js", document.baseURI);
      const scopeUrl = new URL("./", workerUrl);
      const registration = await navigator.serviceWorker.register(workerUrl, {
        scope: scopeUrl.pathname,
        updateViaCache: "none",
      });

      currentRegistration = registration;
      publish({
        offlineReady: Boolean(registration.active || navigator.serviceWorker.controller),
        updateAvailable: Boolean(registration.waiting),
        registrationError: null,
      });

      if (registration.installing) {
        watchInstallingWorker(registration.installing, registration);
      }

      registration.addEventListener("updatefound", () => {
        if (registration.installing) {
          watchInstallingWorker(registration.installing, registration);
        }
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        publish({ offlineReady: true, updateAvailable: false });
      });

      void registration.update().catch(() => {
        // A failed update check must not disable the already-installed offline app.
      });

      return registration;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Offline support could not be enabled.";
      publish({ registrationError: message });
      return null;
    }
  })();

  return registrationPromise;
}

export async function promptPwaInstall(): Promise<PwaInstallOutcome> {
  if (!pendingInstallPrompt) return "unavailable";

  const prompt = pendingInstallPrompt;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  pendingInstallPrompt = null;
  publish({ canInstall: false });
  return choice.outcome;
}

export async function activatePwaUpdate(): Promise<boolean> {
  const registration = currentRegistration;
  if (!registration) return false;

  if (!registration.waiting) {
    await registration.update().catch(() => undefined);
  }

  const waitingWorker = registration.waiting;
  if (!waitingWorker) return false;

  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

export function usePwa(): PwaControls {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...state,
    install: promptPwaInstall,
    update: activatePwaUpdate,
  };
}
