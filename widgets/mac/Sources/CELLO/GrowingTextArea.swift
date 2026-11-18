// A text box that starts a few lines tall and grows as the person types. It's AppKit's own text view, so paste,
// dictation, undo and input methods all work in it. What Return does is decided in CELLOCore (TextArea).
import AppKit
import CELLOCore
import SwiftUI

struct GrowingTextArea: View {
    let placeholder: String
    @Binding var text: String
    var minLines = TextArea.minLines
    // Takes the typing focus as soon as it appears.
    var focused = false
    // Escape, when set. Unset, Escape goes on to the panel, which closes.
    var onCancel: (() -> Void)?
    let onSubmit: () -> Void
    @State private var height: CGFloat = 0

    var body: some View {
        TextAreaView(text: $text, height: $height, minLines: minLines, focused: focused, onCancel: onCancel, onSubmit: onSubmit)
            .frame(height: max(height, 1))
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder).font(.system(size: 13)).foregroundColor(Color(nsColor: .placeholderTextColor))
                        .padding(.leading, TextAreaView.inset + 5).padding(.top, TextAreaView.inset)
                        .allowsHitTesting(false)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.35)))
    }
}

private struct TextAreaView: NSViewRepresentable {
    static let inset: CGFloat = 5
    static let font = NSFont.systemFont(ofSize: 13)

    @Binding var text: String
    @Binding var height: CGFloat
    let minLines: Int
    let focused: Bool
    let onCancel: (() -> Void)?
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        let view = scroll.documentView as! NSTextView
        view.delegate = context.coordinator
        view.font = Self.font
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.drawsBackground = true
        view.backgroundColor = .textBackgroundColor
        view.textContainerInset = NSSize(width: 0, height: Self.inset)
        view.string = text
        let focused = self.focused
        DispatchQueue.main.async {
            context.coordinator.measure(view)
            if focused { view.window?.makeFirstResponder(view) }
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView, view.string != text else { return }
        // Cleared after sending, or a draft put back after a failure.
        view.string = text
        // After this update, since measuring sets the height SwiftUI is drawing.
        DispatchQueue.main.async { context.coordinator.measure(view) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TextAreaView

        init(_ parent: TextAreaView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            measure(view)
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            // Escape while an input method is composing belongs to it, like Return.
            if selector == #selector(NSResponder.cancelOperation(_:)), let cancel = parent.onCancel, !textView.hasMarkedText() {
                cancel()
                return true
            }
            guard selector == #selector(NSResponder.insertNewline(_:)) || selector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)) else { return false }
            let flags = NSApp.currentEvent?.modifierFlags ?? []
            let option = flags.contains(.option) || selector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:))
            switch TextArea.onReturn(shift: flags.contains(.shift), option: option, composing: textView.hasMarkedText()) {
            case .send:
                parent.onSubmit()
                return true
            case .newLine:
                textView.insertText("\n", replacementRange: textView.selectedRange())
                return true
            case .leave:
                return false
            }
        }

        func measure(_ view: NSTextView) {
            guard let layout = view.layoutManager, let container = view.textContainer else { return }
            layout.ensureLayout(for: container)
            let used = layout.usedRect(for: container).height
            let line = layout.defaultLineHeight(for: TextAreaView.font)
            let next = CGFloat(TextArea.height(contentHeight: Double(used), lineHeight: Double(line), inset: Double(TextAreaView.inset), minLines: parent.minLines))
            if abs(next - parent.height) > 0.5 { parent.height = next }
        }
    }
}
