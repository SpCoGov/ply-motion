import { create } from 'zustand';
import { editorSnapshot, subscribeEditor } from '../app.ts';
export type { Easing, Keyframe, SceneObject, Clip } from '../lib/types.ts';
type Snapshot = ReturnType<typeof editorSnapshot>;
export const useEditor = create<Snapshot>(() => editorSnapshot());
const unsubscribe = subscribeEditor(snapshot => useEditor.setState(snapshot));
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
