/**
 * Minimal TUI plugin API surface.
 *
 * Mirrors the local delegation TUI types so @op1/fast-mode can expose
 * a standalone TUI entrypoint without introducing a cross-package runtime
 * dependency.
 */

// biome-ignore lint/suspicious/noExplicitAny: opaque runtime type from host
export type AnyElement = any;

export interface TuiRouteDefinition {
	name: string;
	render: (input: { params?: Record<string, unknown> }) => AnyElement;
}

export interface TuiCommand {
	title: string;
	value: string;
	description?: string;
	category?: string;
	keybind?: string;
	suggested?: boolean;
	hidden?: boolean;
	enabled?: boolean;
	onSelect?: () => void;
}

export interface TuiDialogSelectOption<Value = unknown> {
	title: string;
	value: Value;
	description?: string;
	footer?: AnyElement | string;
	category?: string;
	disabled?: boolean;
	onSelect?: () => void;
}

export interface TuiDialogSelectProps<Value = unknown> {
	title: string;
	placeholder?: string;
	options: TuiDialogSelectOption<Value>[];
	flat?: boolean;
	onSelect?: (option: TuiDialogSelectOption<Value>) => void;
	skipFilter?: boolean;
	current?: Value;
}

export interface TuiDialogStack {
	replace: (render: () => AnyElement, onClose?: () => void) => void;
	clear: () => void;
}

export interface TuiSlotPlugin {
	setup?: () => void;
	slots: Record<string, (props: Record<string, unknown>) => AnyElement>;
}

export interface TuiPluginApi {
	app: { readonly version: string };
	command: {
		register: (cb: () => TuiCommand[]) => () => void;
		trigger: (value: string) => void;
		show: () => void;
	};
	route: {
		register: (routes: TuiRouteDefinition[]) => () => void;
		navigate: (name: string, params?: Record<string, unknown>) => void;
		readonly current: { name: string; params?: Record<string, unknown> };
	};
	ui: {
		DialogSelect: <Value = unknown>(
			props: TuiDialogSelectProps<Value>,
		) => AnyElement;
		toast: (input: {
			variant?: "info" | "success" | "warning" | "error";
			title?: string;
			message: string;
			duration?: number;
		}) => void;
		dialog: TuiDialogStack;
	};
	state: {
		readonly ready: boolean;
		readonly path: {
			state: string;
			config: string;
			worktree: string;
			directory: string;
		};
	};
	slots: {
		register: (plugin: TuiSlotPlugin & { id?: never }) => string;
	};
	lifecycle: {
		readonly signal: AbortSignal;
		onDispose: (fn: () => void | Promise<void>) => () => void;
	};
}

// biome-ignore lint/suspicious/noExplicitAny: options are opaque
export type PluginOptions = any;

export interface TuiPluginMeta {
	state: "first" | "updated" | "same";
	id: string;
	source: string;
	spec: string;
	target: string;
}

export type TuiPlugin = (
	api: TuiPluginApi,
	options: PluginOptions | undefined,
	meta: TuiPluginMeta,
) => Promise<void>;

export interface TuiPluginModule {
	id?: string;
	tui: TuiPlugin;
	server?: never;
}
