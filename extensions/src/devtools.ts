import { PANEL_VISIBILITY_CALLBACK, type DevtoolsPanelWindow } from './panelVisibility.js'

interface DevtoolsEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void
}

interface DevtoolsPanel {
  onHidden: DevtoolsEvent<() => void>
  onShown: DevtoolsEvent<(window: DevtoolsPanelWindow) => void>
}

interface DevtoolsPanelsApi {
  create(
    title: string,
    iconPath: string,
    pagePath: string,
    callback: (panel: DevtoolsPanel) => void,
  ): void
}

declare const chrome: { devtools: { panels: DevtoolsPanelsApi } }

chrome.devtools.panels.create('Figbird', 'icons/icon16.png', 'panel.html', panel => {
  let panelWindow: DevtoolsPanelWindow | null = null
  panel.onShown.addListener(window => {
    panelWindow = window
    panelWindow[PANEL_VISIBILITY_CALLBACK]?.(true)
  })
  panel.onHidden.addListener(() => panelWindow?.[PANEL_VISIBILITY_CALLBACK]?.(false))
})
