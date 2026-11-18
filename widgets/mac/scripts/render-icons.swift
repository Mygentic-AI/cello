// Renders the CELLO mark for the menu bar and the pink tile for the app icon, from the SVGs in Resources.
//   render-icons <cello-mark.svg> <cello-tile.svg> <out folder>
// Writes menubar-mark.png and menubar-mark@2x.png, and CELLO.iconset for iconutil.
import AppKit

let args = CommandLine.arguments
guard args.count == 4 else {
    FileHandle.standardError.write(Data("usage: render-icons <cello-mark.svg> <cello-tile.svg> <out folder>\n".utf8))
    exit(2)
}

func load(_ path: String) -> NSImage {
    guard let image = NSImage(contentsOfFile: path) else {
        FileHandle.standardError.write(Data("couldn't read \(path) as an image\n".utf8))
        exit(1)
    }
    return image
}

func write(_ image: NSImage, pixels: Int, to path: String) {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
    do {
        try png.write(to: URL(fileURLWithPath: path))
    } catch {
        FileHandle.standardError.write(Data("couldn't write \(path): \(error)\n".utf8))
        exit(1)
    }
}

let mark = load(args[1])
let tile = load(args[2])
let out = args[3]
let iconset = (out as NSString).appendingPathComponent("CELLO.iconset")
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)

write(mark, pixels: 18, to: (out as NSString).appendingPathComponent("menubar-mark.png"))
write(mark, pixels: 36, to: (out as NSString).appendingPathComponent("menubar-mark@2x.png"))
for size in [16, 32, 128, 256, 512] {
    write(tile, pixels: size, to: (iconset as NSString).appendingPathComponent("icon_\(size)x\(size).png"))
    write(tile, pixels: size * 2, to: (iconset as NSString).appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
