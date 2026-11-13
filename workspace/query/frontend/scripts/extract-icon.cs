// 提取 exe 的"关联图标"（= 资源管理器/任务栏会显示的那个），导出 PNG 供人眼核对。
// 编译：csc /nologo /target:exe /out:build\extract-icon.exe extract-icon.cs /r:System.Drawing.dll
// 用法：extract-icon.exe <file.exe> <out.png> [size]
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

class ExtractIcon
{
    // 资源管理器/任务栏取大图标走的就是 shell 这一套（SHDefExtractIcon）——
    // 用它才能验证 ICO 里 **256 的 PNG 条目**到底能不能被系统读出来。
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHDefExtractIconW(string pszIconFile, int iIndex, uint uFlags, out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);

    static int Main(string[] args)
    {
        // --shell <file> <out.png> <size>：按系统 shell 的方式取指定尺寸
        if (args.Length >= 4 && args[0] == "--shell")
        {
            string f = args[1], outp = args[2];
            int want = int.Parse(args[3]);
            uint sizeSpec = (uint)(want | (want << 16));
            IntPtr large, small;
            int hr = SHDefExtractIconW(f, 0, 0, out large, out small, sizeSpec);
            Console.WriteLine("SHDefExtractIcon hr=0x" + hr.ToString("X8") + " large=" + (large != IntPtr.Zero) + " small=" + (small != IntPtr.Zero));
            IntPtr use = large != IntPtr.Zero ? large : small;
            if (use == IntPtr.Zero) { Console.WriteLine("shell 没给出图标"); return 3; }
            using (Icon ic = Icon.FromHandle(use))
            using (Bitmap b = ic.ToBitmap())
            {
                b.Save(outp, ImageFormat.Png);
                Console.WriteLine("shell icon " + b.Width + "x" + b.Height + " -> " + outp);
            }
            if (large != IntPtr.Zero) DestroyIcon(large);
            if (small != IntPtr.Zero) DestroyIcon(small);
            return 0;
        }
        if (args.Length < 2) { Console.WriteLine("usage: extract-icon.exe <file> <out.png> [size]"); return 2; }
        string src = args[0], outPath = args[1];
        int size = args.Length >= 3 ? int.Parse(args[2]) : 0;
        if (!File.Exists(src)) { Console.WriteLine("missing: " + src); return 2; }
        using (Icon ic = Icon.ExtractAssociatedIcon(src))
        {
            if (ic == null) { Console.WriteLine("no associated icon"); return 3; }
            using (Bitmap b = ic.ToBitmap())
            {
                Bitmap outBmp = b;
                if (size > 0 && (b.Width != size || b.Height != size))
                {
                    outBmp = new Bitmap(size, size);
                    using (Graphics g = Graphics.FromImage(outBmp))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.DrawImage(b, new Rectangle(0, 0, size, size));
                    }
                }
                outBmp.Save(outPath, ImageFormat.Png);
                Console.WriteLine("icon " + b.Width + "x" + b.Height + " -> " + outPath);
                if (outBmp != b) outBmp.Dispose();
            }
        }
        return 0;
    }
}
