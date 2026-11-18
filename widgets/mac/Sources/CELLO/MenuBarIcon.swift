// The five menu-bar looks, all drawn from the CELLO mark, never a system symbol. Plain, paused and struck-through are
// template images, so macOS colours them for a light or dark menu bar. The dot and the pink fill can't be.
import AppKit
import CELLOCore

enum MenuBarIcon {
    static let pink = NSColor(srgbRed: 0xDB / 255, green: 0x27 / 255, blue: 0x77 / 255, alpha: 1)

    // Rendered from Resources/cello-mark.svg by scripts/assemble.sh, at 1x and 2x.
    static let mark: NSImage = {
        guard let image = Bundle.main.image(forResource: "menubar-mark") else {
            fatalError("menubar-mark.png is missing from CELLO.app/Contents/Resources. Build the app with widgets/mac/scripts/assemble.sh.")
        }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }()

    static func apply(_ mark: MarkLook, to button: NSStatusBarButton) {
        let look = mark.look
        button.appearsDisabled = false
        button.title = mark.word.map { " " + $0 } ?? ""
        button.imagePosition = mark.word == nil ? .imageOnly : .imageLeading
        button.image = image(for: look)
        // Hovering over the faded mark says until when.
        button.toolTip = mark.tooltip
        switch look {
        case .plain: button.setAccessibilityLabel(Copy.lookPlain)
        case .news: button.setAccessibilityLabel(Copy.lookNews)
        case .waiting: button.setAccessibilityLabel(Copy.lookWaiting)
        case .paused:
            button.appearsDisabled = true
            button.setAccessibilityLabel(Copy.lookPaused)
        case .unreachable: button.setAccessibilityLabel(Copy.lookUnreachable)
        }
    }

    static func image(for look: Look) -> NSImage {
        switch look {
        case .plain, .paused: return mark
        case .news: return withDot()
        case .waiting: return filled()
        case .unreachable: return struck()
        }
    }

    // The mark in one colour, on its own canvas first, so the fill touches only the mark and not what's behind it.
    private static func drawMark(in rect: NSRect, color: NSColor) {
        let tinted = NSImage(size: rect.size, flipped: false) { canvas in
            mark.draw(in: canvas)
            color.set()
            canvas.fill(using: .sourceAtop)
            return true
        }
        tinted.draw(in: rect)
    }

    private static func withDot() -> NSImage {
        // Drawn when shown, so labelColor follows the menu bar's own appearance.
        NSImage(size: NSSize(width: 22, height: 18), flipped: false) { _ in
            drawMark(in: NSRect(x: 0, y: 0, width: 18, height: 18), color: .labelColor)
            pink.set()
            NSBezierPath(ovalIn: NSRect(x: 15, y: 11, width: 7, height: 7)).fill()
            return true
        }
    }

    private static func filled() -> NSImage {
        NSImage(size: NSSize(width: 26, height: 20), flipped: false) { rect in
            pink.set()
            NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5).fill()
            drawMark(in: NSRect(x: 5, y: 1, width: 18, height: 18), color: .white)
            return true
        }
    }

    private static func struck() -> NSImage {
        let image = NSImage(size: NSSize(width: 22, height: 18), flipped: false) { _ in
            mark.draw(in: NSRect(x: 2, y: 0, width: 18, height: 18), from: .zero, operation: .sourceOver, fraction: 0.45)
            NSColor.black.set()
            let line = NSBezierPath()
            line.lineWidth = 2
            line.move(to: NSPoint(x: 1, y: 2))
            line.line(to: NSPoint(x: 21, y: 16))
            line.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}
