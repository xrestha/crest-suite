Crest Print Helper {{VERSION}}
==========================

The Crest Print Helper prints your Crest kitchen (KOT) and bar (BOT) tickets
on receipt printers connected to your network (plugged into the router).
It can print Nepali dish names.


WHAT YOU NEED

- A Windows 10 or 11 computer at the counter that stays on during service.
- Your receipt printer plugged into the same router as this computer, with a
  fixed address such as 192.168.1.50. The printer's self-test page (hold the
  FEED button while switching it on) usually shows its address.


INSTALL

1. Right-click CrestPrintHelper.zip and choose "Extract All".
2. Open the extracted folder and double-click CrestPrintHelper.exe.
3. If Windows says "Windows protected your PC", click "More info", then
   "Run anyway". This happens once, because the helper is new and not yet
   signed by Microsoft.
4. In Crest, open POS Setup -> Printers, add a Crest Print Helper with your
   printer's address, and type the pairing code Crest shows into the helper's
   window, then press Enter.
5. When the helper asks "Start the helper automatically when Windows starts?",
   press Enter (yes). From then on it starts by itself, minimized, every time
   you sign in to Windows. You can delete the downloaded copy afterwards.


EVERY DAY

- Leave the helper's window open. Minimized is fine. If it is closed, tickets
  print on the till instead.
- The window shows each ticket it prints and any printer problem, in plain
  words, with what to check.


CHECK A PRINTER WITHOUT CREST

Open the folder with CrestPrintHelper.exe, click the address bar, type cmd and
press Enter. Then type (with your printer's address):

    CrestPrintHelper.exe --test-print 192.168.1.50

For a different port or 58 mm paper:

    CrestPrintHelper.exe --test-print 192.168.1.50 9100 58


PAIR AGAIN

If the helper was removed in Crest, it asks for a new pairing code by itself.
To start over on purpose, run:  CrestPrintHelper.exe --pair


REMOVE

1. Close the helper's window.
2. Press Windows+R, type shell:startup and press Enter, then delete
   "Crest Print Helper.cmd".
3. Press Windows+R, type %LOCALAPPDATA%\CrestPrintHelper and delete the
   program. Its settings and log file are in %APPDATA%\CrestPrintHelper.


The helper uses the Noto fonts under the SIL Open Font License 1.1
(see FONTS-LICENSE.txt), and Node.js and HarfBuzz under their MIT licences
(see THIRD-PARTY-LICENSES.txt).
