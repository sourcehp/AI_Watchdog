// 파일·폴더·디스크에 아이콘 붙이기:  seticon <이미지> <경로>
// 디스크(볼륨) 루트를 주면 macOS 가 .VolumeIcon.icns 를 만들어 디스크 아이콘으로 씀.
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let image = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write(Data("usage: seticon <image> <path>\n".utf8))
    exit(2)
}
exit(NSWorkspace.shared.setIcon(image, forFile: args[2], options: []) ? 0 : 1)
