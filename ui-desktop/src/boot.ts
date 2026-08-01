import { getCurrentWindow } from '@tauri-apps/api/window'

void getCurrentWindow().show().finally(() => import('./main'))
