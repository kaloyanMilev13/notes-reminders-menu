import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Logic from './logic.js';

// Notes are stored here (outside the extension folder, so updates never wipe them).
const DATA_FILE = GLib.build_filenamev([GLib.get_user_data_dir(), 'notes-reminders-menu.json']);

const TITLE = 'Notes & reminders';
// Space between the notes section and the notifications, in pixels.
const GAP = 12;
// How often due reminders are checked, in seconds.
const CHECK_SECONDS = 5;
// How long "Snooze" postpones a reminder, in minutes.
const SNOOZE_MINUTES = 10;
// A reminder that is later than this when it fires is shown as "Missed reminder".
const MISSED_AFTER_MS = 90 * 1000;

// Vertical layout: first child (notes) gets 2/3 of the height,
// second child (notifications) gets 1/3.
// The reported height is 0 on purpose: the row height is decided by the calendar
// column on the right, this column just stretches to match it.
const SplitLayout = GObject.registerClass(
class NotesSplitLayout extends Clutter.LayoutManager {
    // The width comes ONLY from the last child (the notifications list, which is what sized
    // this column originally). The notes section must never influence it, otherwise long
    // notes or help text would make the whole menu wider.
    vfunc_get_preferred_width(container, _forHeight) {
        const children = container.get_children();
        const reference = children[children.length - 1];
        if (!reference)
            return [0, 0];
        return reference.get_preferred_width(-1);
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const [first, second] = container.get_children();
        const width = box.get_width();
        const height = box.get_height();
        const firstHeight = Math.floor((height - GAP) * 2 / 3);

        const firstBox = new Clutter.ActorBox();
        firstBox.x1 = 0;
        firstBox.y1 = 0;
        firstBox.x2 = width;
        firstBox.y2 = firstHeight;
        first.allocate(firstBox);

        if (second) {
            const secondBox = new Clutter.ActorBox();
            secondBox.x1 = 0;
            secondBox.y1 = firstHeight + GAP;
            secondBox.x2 = width;
            secondBox.y2 = height;
            second.allocate(secondBox);
        }
    }
});

export default class NotesRemindersExtension extends Extension {
    enable() {
        this._items = this._load();
        this._uiBuilt = false;
        this._editingId = null;
        this._source = null;

        // The extension stays enabled while the screen is locked (so reminders still fire),
        // but the clock menu only exists in a normal session. Build/remove the UI as needed.
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncUi());
        this._syncUi();

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_SECONDS, () => {
            this._checkReminders();
            return GLib.SOURCE_CONTINUE;
        });
        this._checkReminders();
    }

    disable() {
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }

        this._destroyUi();

        if (this._source) {
            try {
                this._source.destroy();
            } catch (e) {
                console.error(`notes-reminders-menu: could not remove notification source: ${e}`);
            }
            this._source = null;
        }
        this._items = null;
    }

    // ---------- UI lifecycle ----------

    _syncUi() {
        const wantUi = Main.sessionMode.currentMode === 'user';
        if (wantUi && !this._uiBuilt)
            this._createUi();
        else if (!wantUi && this._uiBuilt)
            this._destroyUi();
    }

    _createUi() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        this._buildUi();

        const messageList = dateMenu._messageList;
        const parent = messageList?.get_parent() ?? null;
        this._split = false;
        if (parent)
            this._split = this._installSplit(messageList, parent);

        if (!this._split) {
            // Fallback if the menu layout is not what we expect: append below everything.
            console.log('notes-reminders-menu: could not split the message list, appending to menu');
            this._scroll.style = 'max-height: 220px;';
            this._helpScroll.style = 'max-height: 220px;';
            dateMenu.menu.box.add_child(this._box);
        }

        this._menu = dateMenu.menu;
        this._openId = this._menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._renderList(); // refresh relative times like "tomorrow"
                this._entry.clutter_text.grab_key_focus();
            } else {
                this._cancelEdit();
                this._setHelp(false);
            }
        });

        this._renderList();
        this._uiBuilt = true;
    }

    // Replaces the notifications column with: notes (2/3) on top, notifications (1/3) below.
    _installSplit(messageList, parent) {
        const index = parent.get_children().indexOf(messageList);
        let column = null;
        let detached = false;
        try {
            parent.remove_child(messageList);
            detached = true;
            column = new St.Widget({
                layout_manager: new SplitLayout(),
                x_expand: messageList.x_expand,
                y_expand: true,
            });
            column.add_child(this._box);
            column.add_child(messageList);
            parent.insert_child_at_index(column, index);
        } catch (e) {
            console.error(`notes-reminders-menu: split failed, undoing: ${e}`);
            try {
                if (column && this._box.get_parent() === column)
                    column.remove_child(this._box);
                if (column && messageList.get_parent() === column)
                    column.remove_child(messageList);
                if (detached && messageList.get_parent() === null)
                    parent.insert_child_at_index(messageList, Math.min(index, parent.get_n_children()));
                column?.destroy();
            } catch (e2) {
                console.error(`notes-reminders-menu: could not undo split: ${e2}`);
            }
            return false;
        }

        this._column = column;
        this._messageList = messageList;
        this._originalParent = parent;
        this._originalIndex = index;
        return true;
    }

    _destroyUi() {
        if (!this._uiBuilt)
            return;

        if (this._openId) {
            try {
                this._menu.disconnect(this._openId);
            } catch (e) {
                // menu already gone
            }
            this._openId = 0;
        }

        if (this._column) {
            // Give the notifications back to the original place. Never destroy them with the column.
            try {
                if (this._messageList.get_parent() === this._column)
                    this._column.remove_child(this._messageList);
                if (this._messageList.get_parent() === null) {
                    this._originalParent.insert_child_at_index(this._messageList,
                        Math.min(this._originalIndex, this._originalParent.get_n_children()));
                }
            } catch (e) {
                console.error(`notes-reminders-menu: could not restore message list: ${e}`);
            }
            this._column.destroy();
        } else {
            this._box.destroy();
        }

        this._column = null;
        this._messageList = null;
        this._originalParent = null;
        this._box = null;
        this._entry = null;
        this._title = null;
        this._error = null;
        this._scroll = null;
        this._helpScroll = null;
        this._helpButton = null;
        this._helpVisible = false;
        this._list = null;
        this._addIcon = null;
        this._menu = null;
        this._editingId = null;
        this._uiBuilt = false;
    }

    // ---------- UI ----------

    _buildUi() {
        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'padding: 12px; spacing: 8px; border-radius: 18px; ' +
                   'background-color: rgba(128, 128, 128, 0.15);',
        });

        const header = new St.BoxLayout({x_expand: true, style: 'spacing: 6px;'});
        this._title = new St.Label({
            text: TITLE,
            style: 'font-weight: bold;',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // An "i" in a circle, drawn here instead of using a themed icon (some icon themes
        // show a light bulb for the information icon).
        this._helpButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Help',
            style: 'width: 20px; height: 20px; padding: 0; border-radius: 12px; ' +
                   'border: 2px solid rgba(170, 170, 170, 0.9);',
            child: new St.Label({
                text: 'i',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: bold; font-size: 13px;',
            }),
        });
        this._helpButton.connect('clicked', () => this._setHelp(!this._helpVisible));
        header.add_child(this._title);
        header.add_child(this._helpButton);
        this._box.add_child(header);

        const row = new St.BoxLayout({x_expand: true, style: 'spacing: 6px;'});
        this._entry = new St.Entry({
            hint_text: 'Take a note or create a reminder',
            can_focus: true,
            x_expand: true,
        });
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._submit());
        text.connect('text-changed', () => this._setError(null));
        text.connect('key-press-event', (_actor, event) => {
            // Escape cancels an edit instead of closing the whole menu.
            if (this._editingId !== null && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._cancelEdit();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._addIcon = new St.Icon({icon_name: 'list-add-symbolic', icon_size: 16});
        const addBtn = new St.Button({
            style_class: 'button',
            can_focus: true,
            child: this._addIcon,
        });
        addBtn.connect('clicked', () => this._submit());

        row.add_child(this._entry);
        row.add_child(addBtn);
        this._box.add_child(row);

        this._error = new St.Label({text: '', visible: false, style: 'color: #ff7b63;'});
        this._error.clutter_text.line_wrap = true;
        this._box.add_child(this._error);

        this._scroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 4px;',
        });
        this._scroll.add_child(this._list);
        this._box.add_child(this._scroll);

        this._buildHelp();
    }

    // ---------- Help ----------

    _buildHelp() {
        this._helpVisible = false;
        this._helpScroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            visible: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 6px;',
        });

        const heading = text => {
            content.add_child(new St.Label({text, style: 'font-weight: bold; padding-top: 4px;'}));
        };
        const paragraph = text => {
            const label = new St.Label({text, x_expand: true});
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            content.add_child(label);
        };

        heading('Notes');
        paragraph('Type something in the box and press Enter (or the + button) to save it as a note.');

        heading('Reminders');
        paragraph('Start your text with a time or date and it becomes a reminder. ' +
                  'Examples:');
        paragraph('•  14:30 call Anna  (next time it is 14:30)\n' +
                  '•  9am take medicine\n' +
                  '•  +10m tea is ready  (also +2h, +3d, +1w)\n' +
                  '•  in 2 days renew passport\n' +
                  '•  tomorrow 9:00 dentist  (9:00 if you leave out the time)\n' +
                  '•  today 18:00 groceries\n' +
                  '•  mon 9:00 team meeting  (or: on friday …)\n' +
                  '•  2026-12-25 10:00 gifts\n' +
                  '•  25/12 10:00 gifts  (day/month, needs a time)\n' +
                  '•  dec 25 10:00 gifts  (or: 25 december 2027 …)');

        heading('Repeating reminders');
        paragraph('•  daily 8:00 pills\n' +
                  '•  weekdays 7:30 get up  (Monday to Friday)\n' +
                  '•  weekly / monthly / yearly / hourly\n' +
                  '•  every mon 9:00 gym\n' +
                  '•  every 2 weeks 9:00 water plants\n' +
                  '•  every other day …\n' +
                  '•  every 3h stretch\n' +
                  'A repeating reminder moves on to its next time after it fires.');

        heading('When a reminder is due');
        paragraph('A notification appears with "Snooze 10 min" (and "Done" for one-time reminders). ' +
                  'Snoozed reminders come back 10 minutes later. ' +
                  'If the reminder came due while you were logged out or the PC was off, ' +
                  'it is shown as "Missed reminder" as soon as you are back. ' +
                  'Reminders also fire while the screen is locked.');

        heading('Managing items');
        paragraph('•  Checkbox: mark as done (done items move to the bottom)\n' +
                  '•  Pencil: edit the text, time or repeat, then press Enter. Esc cancels\n' +
                  '•  ✕: delete\n' +
                  '•  Snooze button: shown on a reminder that already went off');

        heading('Good to know');
        paragraph('•  A date without a time, like "mon" or "1/2", is only a reminder if you also ' +
                  'give a time, so notes like "1/2 cup flour" stay notes.\n' +
                  '•  To force a plain note, start with a backslash: \\tomorrow is a word\n' +
                  '•  Dates in the past are refused, except while editing.');

        this._helpScroll.add_child(content);
        this._box.add_child(this._helpScroll);
    }

    // Shows the help instead of the list (or goes back to the list).
    _setHelp(show) {
        if (!this._helpScroll || !this._scroll)
            return;
        this._helpVisible = show;
        this._helpScroll.visible = show;
        this._scroll.visible = !show;
        if (!show && this._entry)
            this._entry.clutter_text.grab_key_focus();
    }

    _setError(message) {
        if (!this._error)
            return;
        this._error.text = message ?? '';
        this._error.visible = !!message;
    }

    _updateEditState() {
        if (!this._title)
            return;
        const editing = this._editingId !== null;
        this._title.text = editing ? 'Editing (Esc to cancel)' : TITLE;
        this._addIcon.icon_name = editing ? 'object-select-symbolic' : 'list-add-symbolic';
    }

    _makeIconButton(iconName, size, onClick) {
        const button = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: size}),
        });
        button.connect('clicked', onClick);
        return button;
    }

    _renderList() {
        if (!this._list || !this._items)
            return;
        this._list.destroy_all_children();

        if (this._items.length === 0) {
            this._list.add_child(new St.Label({text: 'Nothing here yet.', opacity: 120}));
            return;
        }

        const now = Date.now();
        // Unfinished items first, finished ones at the bottom (stable sort keeps the order otherwise).
        const sorted = [...this._items].sort((a, b) => Number(a.done) - Number(b.done));
        for (const item of sorted)
            this._list.add_child(this._makeRow(item, now));
    }

    _makeRow(item, now) {
        const editing = item.id === this._editingId;
        const row = new St.BoxLayout({
            x_expand: true,
            style: editing
                ? 'spacing: 6px; padding: 2px; border-radius: 8px; background-color: rgba(128, 128, 128, 0.25);'
                : 'spacing: 6px;',
        });

        const check = this._makeIconButton(
            item.done ? 'checkbox-checked-symbolic' : 'checkbox-symbolic', 16,
            () => this._toggleDone(item.id));

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            text: item.text,
            x_expand: true,
            opacity: item.done ? 110 : 255,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        content.add_child(label);

        if (item.due !== null) {
            let meta = `⏰ ${Logic.formatDue(item.due, now)}`;
            if (item.repeat)
                meta += ` · ${Logic.formatRepeat(item.repeat)}`;
            else if (item.fired && !item.done)
                meta += ' · reminded';
            content.add_child(new St.Label({
                text: meta,
                x_expand: true,
                opacity: item.done ? 80 : 150,
            }));
        }

        row.add_child(check);
        row.add_child(content);

        if (item.due !== null && item.fired && !item.done && !item.repeat) {
            const snooze = new St.Button({
                style_class: 'button',
                can_focus: true,
                label: `Snooze ${SNOOZE_MINUTES}m`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 2px 8px;',
            });
            snooze.connect('clicked', () => this._snooze(item.id, SNOOZE_MINUTES));
            row.add_child(snooze);
        }

        row.add_child(this._makeIconButton('document-edit-symbolic', 14, () => this._startEdit(item.id)));
        row.add_child(this._makeIconButton('window-close-symbolic', 14, () => this._delete(item.id)));
        return row;
    }

    // ---------- Actions ----------

    _newId() {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    _find(id) {
        return this._items?.find(i => i.id === id) ?? null;
    }

    _commit() {
        this._save();
        this._renderList();
    }

    _itemFromResult(result) {
        return {
            id: this._newId(),
            text: result.text,
            done: false,
            due: result.type === 'reminder' ? result.due : null,
            fired: false,
            repeat: result.type === 'reminder' ? result.repeat : null,
        };
    }

    _submit() {
        if (!this._items || !this._entry)
            return;
        const editing = this._editingId !== null;
        const result = Logic.parseInput(this._entry.get_text(), Date.now(), {allowPast: editing});

        if (result.type === 'empty')
            return;
        if (result.type === 'error') {
            this._setError(result.message);
            return;
        }

        if (editing)
            this._applyEdit(result);
        else
            this._items.push(this._itemFromResult(result));

        this._editingId = null;
        this._entry.set_text('');
        this._updateEditState();
        this._commit();
    }

    _applyEdit(result) {
        const item = this._find(this._editingId);
        if (!item) {
            // It was deleted while editing: keep what the user typed as a new item.
            this._items.push(this._itemFromResult(result));
            return;
        }

        const oldDue = item.due;
        const oldRepeat = JSON.stringify(item.repeat);
        item.text = result.text;

        if (result.type === 'note') {
            item.due = null;
            item.repeat = null;
            item.fired = false;
            return;
        }

        if (result.repeat) {
            // Same schedule as before: keep the current timing, just the text changed.
            if (oldDue !== null && oldRepeat === JSON.stringify(result.repeat))
                return;
            item.repeat = result.repeat;
            item.due = result.due;
            item.fired = false;
            return;
        }

        item.repeat = null;
        // Same minute as before: keep the exact time and whether it already fired.
        if (oldDue !== null && Logic.sameMinute(oldDue, result.due))
            return;
        item.due = result.due;
        item.fired = false;
    }

    _startEdit(id) {
        const item = this._find(id);
        if (!item || !this._entry)
            return;
        this._editingId = id;
        this._entry.set_text(Logic.toEditString(item));
        this._setError(null);
        this._updateEditState();
        this._renderList();
        this._entry.clutter_text.grab_key_focus();
        this._entry.clutter_text.set_cursor_position(-1);
    }

    _cancelEdit() {
        if (!this._entry || this._editingId === null)
            return;
        this._editingId = null;
        this._entry.set_text('');
        this._setError(null);
        this._updateEditState();
        this._renderList();
    }

    _toggleDone(id) {
        const item = this._find(id);
        if (!item)
            return;
        item.done = !item.done;
        // Bringing a repeating reminder back: jump to its next occurrence instead of firing a stale one.
        if (!item.done && item.repeat && item.due !== null && item.due <= Date.now()) {
            item.due = Logic.nextAfter(item.repeat, item.due, Date.now());
            item.fired = false;
        }
        this._commit();
    }

    _delete(id) {
        if (!this._items)
            return;
        if (id === this._editingId)
            this._cancelEdit();
        this._items = this._items.filter(i => i.id !== id);
        this._commit();
    }

    _markDone(id) {
        const item = this._find(id);
        if (!item || item.repeat)
            return;
        item.done = true;
        this._commit();
    }

    // Postpones a reminder. A repeating reminder keeps its schedule; the snooze becomes a
    // separate one-time reminder with the same text.
    _snooze(id, minutes, fallbackText) {
        if (!this._items)
            return;
        const due = Date.now() + minutes * 60 * 1000;
        const item = this._find(id);

        if (item && !item.repeat) {
            item.due = due;
            item.fired = false;
            item.done = false;
        } else {
            const text = item ? item.text : fallbackText;
            if (!text)
                return;
            this._items.push({id: this._newId(), text, done: false, due, fired: false, repeat: null});
        }
        this._commit();
    }

    // ---------- Reminders ----------

    _checkReminders() {
        if (!this._items)
            return;
        const now = Date.now();
        let changed = false;

        for (const item of [...this._items]) {
            if (item.due === null || item.done || item.fired || item.due > now)
                continue;

            const dueAt = item.due;
            const missed = now - dueAt > MISSED_AFTER_MS;
            changed = true;

            if (item.repeat) {
                // Skip any occurrences that were missed and schedule the next one.
                item.due = Logic.nextAfter(item.repeat, dueAt, now);
                item.fired = false;
            } else {
                item.fired = true;
            }
            this._notify(item, missed ? dueAt : null);
        }

        if (changed)
            this._commit();
    }

    _ensureSource() {
        if (this._source)
            return this._source;
        const source = new MessageTray.Source({title: TITLE, iconName: 'alarm-symbolic'});
        source.connect('destroy', () => {
            if (this._source === source)
                this._source = null;
        });
        Main.messageTray.add(source);
        this._source = source;
        return source;
    }

    _notify(item, missedDue) {
        const missed = missedDue !== null;
        const title = missed ? 'Missed reminder' : 'Reminder';
        const body = missed
            ? `${item.text}\n(was due ${Logic.formatDue(missedDue, Date.now())})`
            : item.text;
        const id = item.id;
        const text = item.text;
        const repeating = !!item.repeat;

        try {
            const source = this._ensureSource();
            const notification = new MessageTray.Notification({source, title, body});
            notification.addAction(`Snooze ${SNOOZE_MINUTES} min`, () => this._snooze(id, SNOOZE_MINUTES, text));
            if (!repeating)
                notification.addAction('Done', () => this._markDone(id));
            if (typeof source.addNotification === 'function')
                source.addNotification(notification);
            else
                source.showNotification(notification);
        } catch (e) {
            console.error(`notes-reminders-menu: rich notification failed, using a plain one: ${e}`);
            try {
                Main.notify(title, body);
            } catch (e2) {
                console.error(`notes-reminders-menu: could not show notification: ${e2}`);
            }
        }
    }

    // ---------- Storage ----------

    _load() {
        try {
            const [ok, data] = GLib.file_get_contents(DATA_FILE);
            if (ok) {
                const parsed = JSON.parse(new TextDecoder().decode(data));
                if (Array.isArray(parsed)) {
                    return parsed
                        .map(raw => Logic.normalizeItem(raw, () => this._newId()))
                        .filter(item => item !== null);
                }
            }
        } catch (e) {
            // no file yet, or unreadable: start empty
        }
        return [];
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.get_user_data_dir(), 0o755);
            GLib.file_set_contents(DATA_FILE, JSON.stringify(this._items));
        } catch (e) {
            console.error(`notes-reminders-menu: could not save: ${e}`);
        }
    }
}
