export const PANEL_VISIBILITY_CALLBACK = '__FIGBIRD_DEVTOOLS_SET_VISIBLE__'

export type DevtoolsPanelWindow = Window & {
  [PANEL_VISIBILITY_CALLBACK]?: (visible: boolean) => void
}
