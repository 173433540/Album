using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class MakeIcon
{
    static readonly int[] Sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };

    static void Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.WriteLine("usage: make-icon <source-image> <assets-dir>");
            Environment.Exit(1);
        }

        string source = args[0];
        string assets = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(assets);

        using (Image src = Image.FromFile(source))
        using (Bitmap canvas = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(canvas))
            {
                g.CompositingMode = CompositingMode.SourceCopy;
                g.DrawImage(src, 0, 0, src.Width, src.Height);
            }

            // 以短边为准居中裁成正方形，避免变形
            int side = Math.Min(canvas.Width, canvas.Height);
            int ox = (canvas.Width - side) / 2;
            int oy = (canvas.Height - side) / 2;

            int count = Sizes.Length;
            MemoryStream[] frames = new MemoryStream[count];
            for (int i = 0; i < count; i++)
            {
                int s = Sizes[i];
                using (Bitmap scaled = Resize(canvas, new Rectangle(ox, oy, side, side), s))
                {
                    frames[i] = s >= 128 ? EncodePng(scaled) : EncodeDib(scaled);
                }
            }

            using (MemoryStream ico = new MemoryStream())
            using (BinaryWriter w = new BinaryWriter(ico))
            {
                w.Write((ushort)0);
                w.Write((ushort)1);
                w.Write((ushort)count);

                int offset = 6 + 16 * count;
                for (int i = 0; i < count; i++)
                {
                    int s = Sizes[i];
                    byte[] data = frames[i].ToArray();
                    w.Write((byte)(s >= 256 ? 0 : s));
                    w.Write((byte)(s >= 256 ? 0 : s));
                    w.Write((byte)0);
                    w.Write((byte)0);
                    w.Write((ushort)1);
                    w.Write((ushort)32);
                    w.Write((uint)data.Length);
                    w.Write((uint)offset);
                    offset += data.Length;
                }
                for (int i = 0; i < count; i++)
                {
                    w.Write(frames[i].ToArray());
                    frames[i].Dispose();
                }
                w.Flush();
                string icoPath = Path.Combine(assets, "app.ico");
                File.WriteAllBytes(icoPath, ico.ToArray());
                Console.WriteLine("icon ok: " + icoPath + " (" + new FileInfo(icoPath).Length + " bytes)");
            }

            SavePng(canvas, new Rectangle(ox, oy, side, side), 256, Path.Combine(assets, "app-256.png"));
        }
    }

    static Bitmap Resize(Bitmap canvas, Rectangle crop, int size)
    {
        Bitmap outBmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(outBmp))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImage(canvas, new Rectangle(0, 0, size, size), crop, GraphicsUnit.Pixel);
        }
        return outBmp;
    }

    static void SavePng(Bitmap canvas, Rectangle crop, int size, string path)
    {
        using (Bitmap bmp = Resize(canvas, crop, size))
        {
            bmp.Save(path, ImageFormat.Png);
        }
    }

    static MemoryStream EncodePng(Bitmap bmp)
    {
        MemoryStream ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        ms.Position = 0;
        return ms;
    }

    /** 32 位 DIB（BMP）帧，兼容性最好；ICO 中高度需要翻倍 */
    static MemoryStream EncodeDib(Bitmap bmp)
    {
        int w = bmp.Width;
        int h = bmp.Height;
        MemoryStream ms = new MemoryStream();
        BinaryWriter w2 = new BinaryWriter(ms);
        {
            w2.Write((uint)40);
            w2.Write((int)w);
            w2.Write((int)(h * 2));
            w2.Write((ushort)1);
            w2.Write((ushort)32);
            w2.Write((uint)0);
            w2.Write((uint)(w * h * 4));
            w2.Write((int)0);
            w2.Write((int)0);
            w2.Write((uint)0);
            w2.Write((uint)0);

            BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = data.Stride;
                byte[] row = new byte[stride];
                for (int y = h - 1; y >= 0; y--)
                {
                    IntPtr ptr = new IntPtr(data.Scan0.ToInt64() + (long)y * stride);
                    System.Runtime.InteropServices.Marshal.Copy(ptr, row, 0, stride);
                    w2.Write(row, 0, w * 4);
                }
            }
            finally
            {
                bmp.UnlockBits(data);
            }

            // AND 掩码：32 位带 alpha，全部置 0
            int maskStride = ((w + 31) / 32) * 4;
            byte[] mask = new byte[maskStride];
            for (int y = 0; y < h; y++) w2.Write(mask, 0, maskStride);
            w2.Flush();
        }
        ms.Position = 0;
        return ms;
    }
}