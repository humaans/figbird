interface DevtoolsPanelsApi {
  create(title: string, iconPath: string, pagePath: string): void
}

declare const chrome: { devtools: { panels: DevtoolsPanelsApi } }

chrome.devtools.panels.create('Figbird', 'icons/icon16.png', 'panel.html')
