package com.cyttos.oli;

import java.io.FileInputStream;
import java.io.FileOutputStream;

/** Test helper (not part of the app): extracts the cover of a FLAC file. usage: PicCli <flac> <outfile> ; prints "none" or the size. */
public class PicCli {
  public static void main(String[] args) throws Exception {
    byte[] pic;
    try (FileInputStream in = new FileInputStream(args[0])) {
      pic = FlacPicture.find(in);
    }
    if (pic == null) {
      System.out.println("none");
      return;
    }
    try (FileOutputStream out = new FileOutputStream(args[1])) {
      out.write(pic);
    }
    System.out.println(pic.length);
  }
}
