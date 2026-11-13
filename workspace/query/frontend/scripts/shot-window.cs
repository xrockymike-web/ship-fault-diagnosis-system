// 抓指定进程的可见顶层窗口（含子控件文本）—— 开发期排障工具，不进产物。
// 编译（零下载，系统自带）：csc /nologo /target:exe /out:build\shot-window.exe shot-window.cs /r:System.Drawing.dll
// 用法：shot-window.exe <pid> <out.png>
// 说明：源码保持纯 ASCII（C# 5 语法 + 无中文字面量），避免 csc 的编码坑（见施工单 §4.7 P22）。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

class ShotWindow
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

    static void Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("usage: shot-window.exe <pid> <out.png>"); return; }
        uint target = uint.Parse(args[0]);
        string outPath = args[1];
        // 可选第 3 个参数：只抓标题包含该子串的窗口（多处弹框时用）
        string titleFilter = args.Length >= 3 ? args[2] : "";

        IntPtr found = IntPtr.Zero;
        string title = "";
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == target && IsWindowVisible(h))
            {
                var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
                string t = sb.ToString();
                if (titleFilter.Length > 0 && t.IndexOf(titleFilter, StringComparison.Ordinal) < 0) return true;
                if (found == IntPtr.Zero) { found = h; title = t; }
            }
            return true;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) { Console.WriteLine("no-visible-window"); return; }

        RECT r; GetWindowRect(found, out r);
        int w = r.R - r.L, hh = r.B - r.T;
        if (w <= 0 || hh <= 0) { Console.WriteLine("bad-rect " + w + "x" + hh); return; }
        using (var bmp = new Bitmap(w, hh))
        using (var g = Graphics.FromImage(bmp))
        {
            IntPtr hdc = g.GetHdc();
            PrintWindow(found, hdc, 2);
            g.ReleaseHdc(hdc);
            bmp.Save(outPath, ImageFormat.Png);
        }
        Console.WriteLine("shot: title=[" + title + "] size=" + w + "x" + hh + " -> " + outPath);

        EnumChildWindows(found, delegate(IntPtr h, IntPtr l)
        {
            var sb = new StringBuilder(4096); GetWindowTextW(h, sb, 4096);
            var cn = new StringBuilder(128); GetClassNameW(h, cn, 128);
            if (sb.Length > 0) Console.WriteLine("  child[" + cn.ToString() + "] = " + sb.ToString());
            return true;
        }, IntPtr.Zero);
    }
}
