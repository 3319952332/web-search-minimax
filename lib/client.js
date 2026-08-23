/**
 * `dsh-web-search-minimax` — browser half.
 *
 * Registers the MiniMax search card into the shared Plugins settings section
 * (`settings.plugin.item`), keyed by the `web-search-minimax` settings
 * namespace the Host half serves through `installSettingsSection`. No bundle
 * patching, no text injection into the shipped `dsh-client-ui-settings-plugins`
 * client: the card ships with this package, so it survives `dsh` updates and
 * `npx` reinstalls as long as this plugin row stays in `cordis.patch.yml`.
 *
 * The card mirrors the DeepSeek web-search card minus the `maxUses` knob: the
 * MiniMax coding-plan direct search API has no per-request search bound, so the
 * card carries only the credential and the endpoint. It depends only on the
 * bundled `react`; the settings scope, connection (credentials), slots, locale,
 * and remote event faces all arrive through cordis services.
 */
window.__ModuleLoader__.load({
	id: "dsh-web-search-minimax",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"settingsScope"
		];

		/** Namespace the MiniMax coding-plan search provider serves on the Host. */
		const MINIMAX_SEARCH_NS = "web-search-minimax";
		/** Credential reference the provider resolves when the section names none. */
		const DEFAULT_API_KEY_REF = "MINIMAX_CN_API_KEY";
		/** Locale namespace owned by this card. */
		const NS = "settings.plugins.minimax";
		/** Hook name the card's store injects under. */
		const HOOK_NAME = "minimaxSearchCard";

		// ---- minimal snapshot store (createSnapshotStore port) ----
		function createSnapshotStore(initial) {
			const listeners = new Set();
			let snapshot = initial;
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (next) => {
					snapshot = next;
					for (const listener of listeners) listener();
				}
			};
		}

		// ---- field spec ----
		/** A free-text field. An empty draft clears the field. */
		function textField(field) {
			return {
				field,
				format: (value) => (typeof value === "string" ? value : ""),
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
				}
			};
		}

		// ---- card form model (port of the settings-plugins CardForm) ----
		/**
		 * Stages one card's edits over one settings namespace and writes them on
		 * save. Publish-through a snapshot store; the scope and the local drafts
		 * both change underneath, and every projection is rebuilt from the two.
		 */
		var CardForm = class {
			constructor(scope, specs, secrets = []) {
				this.scope = scope;
				this.specs = new Map(specs.map((spec) => [spec.field, spec]));
				this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]));
				this.staged = new Map();
				this.listeners = new Set();
				this.saving = false;
				this.failed = false;
				scope.subscribe(() => {
					this.publish();
				});
			}
			bind(project) {
				const store = createSnapshotStore(project());
				this.listeners.add(() => {
					store.set(project());
				});
				return store;
			}
			shell() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.run === void 0),
					saving: this.saving,
					failed: this.failed
				};
			}
			field(field) {
				const staged = this.staged.get(field);
				if (this.secretSpecs.has(field)) return { text: staged?.text ?? "", overridden: false, invalid: false };
				const spec = this.spec(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(field)),
					overridden: this.stored(field),
					invalid: false
				};
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write?.kind === "set",
					invalid: write === void 0
				};
			}
			actions() {
				return {
					edit: (field, text) => {
						this.stage(field, { text, clear: false });
					},
					resetField: (field) => {
						this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			async save() {
				const plan = this.plan();
				const writes = plan.flatMap((item) => item.run === void 0 ? [] : [item.run]);
				if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) landed = await write() && landed;
				if (landed) this.staged.clear();
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const secret = this.secretSpecs.get(field);
					if (secret !== void 0) {
						const value = staged.text.trim();
						if (value !== "") plan.push({ field, run: () => secret.write(value) });
						continue;
					}
					const spec = this.spec(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({ field, run: () => this.clear(field) });
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({ field, run: void 0 });
					else if (write.kind === "clear") plan.push({ field, run: () => this.clear(field) });
					else plan.push({ field, run: () => this.store(field, write.value) });
				}
				return plan;
			}
			async clear(field) {
				await this.scope.unset(field);
				return !this.stored(field);
			}
			async store(field, value) {
				await this.scope.set(field, value);
				return this.userLayer()?.[field] === value;
			}
			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				this.publish();
			}
			spec(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`plugin card has no field ${field}`);
				return spec;
			}
			snapshotOf() {
				return this.scope.getSnapshot();
			}
			sectionValue(field) {
				return this.snapshotOf().value?.[field];
			}
			baseValue(field) {
				return this.snapshotOf().base?.[field];
			}
			userLayer() {
				return this.snapshotOf().user;
			}
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			publish() {
				for (const listener of this.listeners) listener();
			}
		};

		// ---- styles ----
		const CSS = `
.dshmms-card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); border-radius: 12px; list-style: none; transition: border-color .16s, background .16s; }
.dshmms-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshmms-cardOpen { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dshmms-header { appearance: none; width: 100%; font: inherit; color: inherit; text-align: left; cursor: pointer; background: 0 0; border: 0; border-radius: 12px; align-items: center; gap: 12px; padding: 14px 16px; display: flex; }
.dshmms-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshmms-headText { flex-direction: column; flex: 1; gap: 4px; min-width: 0; display: flex; }
.dshmms-name { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 1.4; }
.dshmms-description { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
.dshmms-chevron { color: var(--dsw-alias-label-tertiary); flex: none; transition: transform .16s; }
.dshmms-chevronOpen { transform: rotate(180deg); }
.dshmms-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.dshmms-readOnly { color: var(--dsw-alias-label-tertiary); margin: 12px 0 0; font-size: 12px; line-height: 1.5; }
.dshmms-pending { white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); border-radius: 999px; flex: none; padding: 1px 8px; font-size: 11px; font-weight: 500; line-height: 17px; }
.dshmms-footer { border-top: 1px solid var(--dsw-alias-border-l2); justify-content: flex-end; align-items: center; gap: 8px; padding: 12px 0 4px; display: flex; }
.dshmms-failed { min-width: 0; color: var(--dsw-alias-label-error); flex: 1; margin: 0; font-size: 12px; line-height: 1.5; }
.dshmms-discard, .dshmms-save { appearance: none; font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font-size: 13px; line-height: 1.5; }
.dshmms-discard { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: 0 0; }
.dshmms-save { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: 0 0; }
.dshmms-save:disabled { opacity: .55; cursor: default; }
.dshmms-discard:disabled { opacity: .55; cursor: default; }
.dshmms-field { flex-direction: column; gap: 6px; padding: 12px 0; display: flex; }
.dshmms-field + .dshmms-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshmms-head { align-items: center; gap: 8px; display: flex; }
.dshmms-label { min-width: 0; color: var(--dsw-alias-label-primary); flex: 1; font-size: 13px; font-weight: 500; line-height: 1.5; }
.dshmms-badges { align-items: center; gap: 8px; display: inline-flex; }
.dshmms-badge { white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 500; line-height: 17px; }
.dshmms-badgeMuted { white-space: nowrap; color: var(--dsw-alias-label-tertiary); border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; }
.dshmms-reset { font: inherit; color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: none; padding: 0; font-size: 12px; line-height: 1.5; }
.dshmms-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dshmms-reset:disabled { cursor: default; }
.dshmms-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); height: 34px; font: inherit; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 0 12px; font-size: 13px; line-height: 1.5; }
.dshmms-input:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.dshmms-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshmms-inputInvalid { border-color: var(--dsw-alias-label-error); }
.dshmms-invalid { color: var(--dsw-alias-label-error); margin: 0; font-size: 12px; line-height: 1.5; }
.dshmms-hint { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 1.5; }
`;

		// ---- controls ----
		function ValueField(props) {
			return React.createElement("div", { className: "dshmms-field" },
				React.createElement("div", { className: "dshmms-head" },
					React.createElement("label", { className: "dshmms-label", htmlFor: props.id }, props.label),
					props.overridden
						? React.createElement("span", { className: "dshmms-badges" },
							React.createElement("span", { className: "dshmms-badge" }, props.overriddenLabel),
							React.createElement("button", { type: "button", className: "dshmms-reset", disabled: props.disabled, onClick: props.onReset }, props.resetLabel),
						)
						: null,
				),
				React.createElement("input", {
					id: props.id,
					className: props.invalid ? "dshmms-input dshmms-inputInvalid" : "dshmms-input",
					type: "text",
					...(props.numeric === true ? { inputMode: "numeric" } : {}),
					...(props.invalid ? { "aria-invalid": true } : {}),
					value: props.text,
					placeholder: props.placeholder ?? "",
					disabled: props.disabled,
					onChange: (event) => props.onEdit(event.target.value),
				}),
				React.createElement("p", { className: props.invalid ? "dshmms-invalid" : "dshmms-hint" },
					props.invalid ? props.invalidLabel : props.hint,
				),
			);
		}

		function SecretField(props) {
			return React.createElement("div", { className: "dshmms-field" },
				React.createElement("div", { className: "dshmms-head" },
					React.createElement("label", { className: "dshmms-label", htmlFor: props.id }, props.label),
					React.createElement("span", { className: "dshmms-badges" },
						React.createElement("span", { className: props.configured ? "dshmms-badge" : "dshmms-badgeMuted" }, props.stateLabel),
					),
				),
				React.createElement("input", {
					id: props.id,
					className: "dshmms-input",
					type: "password",
					autoComplete: "off",
					value: props.text,
					disabled: props.disabled,
					onChange: (event) => props.onEdit(event.target.value),
				}),
				React.createElement("p", { className: "dshmms-hint" }, props.hint),
			);
		}

		function PluginCard(props) {
			const [open, setOpen] = React.useState(false);
			const { state } = props;
			if (!state.available) return null;
			const title = props.t(props.titleKey);
			const blocked = !state.dirty || state.invalid || state.saving;
			return React.createElement("li",
				{ className: open ? "dshmms-card dshmms-cardOpen" : "dshmms-card" },
				React.createElement("button", {
					type: "button",
					className: "dshmms-header",
					"aria-expanded": open,
					"aria-label": `${props.t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => setOpen(!open),
				},
					React.createElement("span", { className: "dshmms-headText" },
						React.createElement("span", { className: "dshmms-name" }, title),
						React.createElement("span", { className: "dshmms-description" }, props.t(props.descriptionKey)),
					),
					state.dirty ? React.createElement("span", { className: "dshmms-pending" }, props.t("unsaved")) : null,
					React.createElement("span", { className: open ? "dshmms-chevron dshmms-chevronOpen" : "dshmms-chevron", "aria-hidden": true }, "▾"),
				),
				open
					? React.createElement("div", { className: "dshmms-body" },
						!state.writable ? React.createElement("p", { className: "dshmms-readOnly", role: "status" }, props.t("readOnly")) : null,
						props.children,
						React.createElement("div", { className: "dshmms-footer" },
							state.failed ? React.createElement("p", { className: "dshmms-failed", role: "status" }, props.t("saveFailed")) : null,
							React.createElement("button", { type: "button", className: "dshmms-discard", disabled: !state.dirty || state.saving, onClick: props.onDiscard }, props.t("discard")),
							React.createElement("button", { type: "button", className: "dshmms-save", disabled: blocked, onClick: props.onSave }, props.t(state.saving ? "saving" : "save")),
						),
					)
					: null,
			);
		}

		// ---- controller ----
		/** The MiniMax card's staged form over the `web-search-minimax` settings namespace. */
		var MiniMaxCardController = class {
			constructor(scope, api) {
				this.scope = scope;
				this.api = api;
				this.credential = { ref: "", configured: false, writable: true };
				this.form = new CardForm(scope, [textField("baseURL")], [{ field: "apiKey", write: (text) => this.writeKey(text) }]);
				this.store = this.form.bind(() => this.projection());
				scope.subscribe(() => {
					this.readCredential();
				});
				this.readCredential();
			}
			projection() {
				return {
					...this.form.shell(),
					baseURL: this.form.field("baseURL"),
					apiKey: this.form.field("apiKey"),
					apiKeyConfigured: this.credential.configured,
					apiKeyWritable: this.credential.writable
				};
			}
			async readCredential() {
				const ref = refOf(this.scope.getSnapshot());
				if (ref !== this.credential.ref) {
					this.credential = { ref, configured: false, writable: true };
					this.store.set(this.projection());
				}
				let response;
				try {
					response = await this.api.credentials.describe({ refs: [ref] });
				} catch (_credentialReadFailure) {
					return;
				}
				if (!response.result.ok || ref !== refOf(this.scope.getSnapshot())) return;
				const view = response.result.value.credentials[ref];
				const next = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true };
				if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
				this.credential = next;
				this.store.set(this.projection());
			}
			refreshCredential(ref) {
				if (ref !== this.credential.ref) return;
				this.readCredential();
			}
			inject() {
				return {
					hooks: { [HOOK_NAME]: this.store },
					...this.form.actions()
				};
			}
			async writeKey(value) {
				try {
					await this.api.credentials.set({ ref: refOf(this.scope.getSnapshot()), value });
				} catch (_credentialWriteFailure) {}
				await this.readCredential();
				return this.credential.configured;
			}
		};

		/** The credential reference the section names, or the provider's default. */
		function refOf(snapshot) {
			const declared = snapshot.value?.apiKeyEnv;
			return declared !== void 0 && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
		}

		// ---- card ----
		/** Render the MiniMax search card. Same shape as the DeepSeek card minus the `maxUses` knob. */
		function MiniMaxCard(props) {
			const { t } = props;
			const state = props.useMinimaxSearchCard((snapshot) => snapshot);
			const disabled = !state.writable;
			return React.createElement(PluginCard, {
				t,
				titleKey: "minimaxSearchTitle",
				descriptionKey: "minimaxSearchDescription",
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					React.createElement(SecretField, {
						id: "plugin-config-minimax-search-key",
						label: t("minimaxSearchApiKey"),
						hint: t("minimaxSearchApiKeyHint"),
						disabled: !state.apiKeyWritable,
						text: state.apiKey.text,
						configured: state.apiKeyConfigured,
						stateLabel: state.apiKeyConfigured ? t("minimaxSearchApiKeySet") : t("minimaxSearchApiKeyUnset"),
						onEdit: (text) => {
							props.edit("apiKey", text);
						}
					}),
					React.createElement(ValueField, {
						id: "plugin-config-minimax-search-endpoint",
						label: t("minimaxSearchBaseUrl"),
						hint: t("minimaxSearchBaseUrlHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						disabled,
						...state.baseURL,
						onEdit: (text) => {
							props.edit("baseURL", text);
						},
						onReset: () => {
							props.resetField("baseURL");
						}
					})
				]
			});
		}

		// ---- locales ----
		const en = {
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			expand: "Show settings",
			collapse: "Hide settings",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			unsaved: "Unsaved",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			minimaxSearchTitle: "MiniMax web search",
			minimaxSearchDescription: "The MiniMax coding-plan search provider.",
			minimaxSearchApiKey: "API key",
			minimaxSearchApiKeyHint: "Stored outside the settings file. Leave blank to keep the current key.",
			minimaxSearchApiKeySet: "A key is configured.",
			minimaxSearchApiKeyUnset: "No key is configured; search is unavailable until one is.",
			minimaxSearchBaseUrl: "Endpoint",
			minimaxSearchBaseUrlHint: "Leave blank to use the provider default."
		};
		const zh = {
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			expand: "展开设置",
			collapse: "收起设置",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			unsaved: "未保存",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。",
			minimaxSearchTitle: "MiniMax 网页搜索",
			minimaxSearchDescription: "MiniMax coding-plan 搜索提供方。",
			minimaxSearchApiKey: "API Key",
			minimaxSearchApiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
			minimaxSearchApiKeySet: "已配置密钥。",
			minimaxSearchApiKeyUnset: "未配置密钥；配置之前搜索不可用。",
			minimaxSearchBaseUrl: "接口地址",
			minimaxSearchBaseUrlHint: "留空则使用提供方默认地址。"
		};

		// ---- apply ----
		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-web-search-minimax";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, "dsh-web-search-minimax: card styles");

			const api = ctx.get("connection").api;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-web-search-minimax: card dictionaries");

			const minimaxSearch = new MiniMaxCardController(ctx.settingsScope.bind({ namespace: MINIMAX_SEARCH_NS }), api);
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
				minimaxSearch.refreshCredential(ref);
			}), "dsh-web-search-minimax: credential invalidations");

			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: MINIMAX_SEARCH_NS,
				locale: NS,
				inject: () => minimaxSearch.inject()
			}, MiniMaxCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
