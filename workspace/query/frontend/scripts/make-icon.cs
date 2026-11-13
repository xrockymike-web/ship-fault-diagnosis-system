// anchor.png -> 多尺寸 .ico（16/32/48/256）—— 零下载：用系统自带 csc.exe 编译。
// 编译：csc /nologo /target:exe /out:build\make-icon.exe make-icon.cs /r:System.Drawing.dll
// 用法：make-icon.exe <src.png> <out.ico>
//       make-icon.exe --dump <in.ico> <outDir>      # 把每个尺寸导成 PNG，便于人眼核对
// 说明：纯 ASCII 源码 + C# 5 语法（无插值、无 ?.、无表达式体），避开 csc v4.0.30319 的两个坑。
// 尺寸策略：16/32/48 写 32bpp DIB（最兼容），256 写 PNG（体积小，Vista+ 支持）。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class MakeIcon
{
    static readonly int[] SIZES = new int[] { 16, 32, 48, 256 };

    static Bitmap Scale(Bitmap src, int size)
    {
        Bitmap b = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(b))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, size, size));
        }
        return b;
    }

    static byte[] Dib32(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        MemoryStream ms = new MemoryStream();
        BinaryWriter bw = new BinaryWriter(ms);
        bw.Write(40); bw.Write(w); bw.Write(h * 2); bw.Write((short)1); bw.Write((short)32);
        bw.Write(0); bw.Write(w * h * 4); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
        for (int y = h - 1; y >= 0; y--)
        {
            for (int x = 0; x < w; x++)
            {
                Color c = bmp.GetPixel(x, y);
                bw.Write(c.B); bw.Write(c.G); bw.Write(c.R); bw.Write(c.A);
            }
        }
        int rowBytes = ((w + 31) / 32) * 4;
        bw.Write(new byte[rowBytes * h]);
        bw.Flush();
        return ms.ToArray();
    }

    static byte[] Png(Bitmap bmp)
    {
        MemoryStream ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    static int Main(string[] args)
    {
        if (args.Length >= 3 && args[0] == "--dump")
        {
            string inIco = args[1], outDir = args[2];
            Directory.CreateDirectory(outDir);
            foreach (int s in SIZES)
            {
                using (Icon ic = new Icon(inIco, new Size(s, s)))
                using (Bitmap b = ic.ToBitmap())
                {
                    string p = Path.Combine(outDir, "ico-" + s + ".png");
                    b.Save(p, ImageFormat.Png);
                    Console.WriteLine("dump " + s + "x" + s + " -> " + p + " (" + b.Width + "x" + b.Height + ")");
                }
            }
            return 0;
        }

        if (args.Length < 2) { Console.WriteLine("usage: make-icon.exe <src.png> <out.ico> | --dump <in.ico> <outDir>"); return 2; }
        string src = args[0], outPath = args[1];
        if (!File.Exists(src)) { Console.WriteLine("missing source: " + src); return 2; }

        List<byte[]> blobs = new List<byte[]>();
        using (Bitmap origin = new Bitmap(src))
        {
            Console.WriteLine("source " + src + " = " + origin.Width + "x" + origin.Height);
            for (int i = 0; i < SIZES.Length; i++)
            {
                int s = SIZES[i];
                using (Bitmap b = Scale(origin, s))
                {
                    byte[] blob = (s >= 256) ? Png(b) : Dib32(b);
                    blobs.Add(blob);
                    Console.WriteLine("  " + s + "x" + s + " " + ((s >= 256) ? "PNG" : "DIB32") + " " + blob.Length + " B");
                }
            }
        }

        using (FileStream fs = File.Create(outPath))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            bw.Write((short)0); bw.Write((short)1); bw.Write((short)SIZES.Length);
            int offset = 6 + 16 * SIZES.Length;
            for (int i = 0; i < SIZES.Length; i++)
            {
                int s = SIZES[i];
                bw.Write((byte)(s >= 256 ? 0 : s));
                bw.Write((byte)(s >= 256 ? 0 : s));
                bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((short)1); bw.Write((short)32);
                bw.Write(blobs[i].Length); bw.Write(offset);
                offset += blobs[i].Length;
            }
            for (int i = 0; i < blobs.Count; i++) bw.Write(blobs[i]);
        }
        FileInfo fi = new FileInfo(outPath);
        Console.WriteLine("wrote " + outPath + " = " + fi.Length + " B, " + SIZES.Length + " sizes");
        return 0;
    }
}
