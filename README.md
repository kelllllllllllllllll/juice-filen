# juice-filen

A simple tool to download files from Filen.

---

## 🚀 Getting Started

1. **Download the Program**

   Go to the [Releases page](https://github.com/kelllllllllllllllll/juice-filen/releases) and download the right file for your system:

   - **Windows:**  
     Download `filen-windows-x64.exe`
   - **Mac:**  
     - For new Macs (after 2020, Apple Silicon): `filen-darwin-arm64`
     - For older Macs (Intel): `filen-darwin-x64`
   - **Linux:**  
     Download the file that matches your system (e.g., `filen-linux-x64`).

2. **Run the Program**

   - **Windows & Mac:**  
     Double-click the file you downloaded.
   - **Linux:**  
     You may need to give it permission to run. Open a terminal and run:
     ```sh
     chmod +x filen-linux-x64
     ./filen-linux-x64
     ```

   The first time you run it, a `config.json` file will be created in the same folder.

---

## ⚙️ Configuration (`config.json`)

Here’s what a typical `config.json` looks like:

```json
{
  "exclude": [
    "/Juice WRLD/Studio Sessions"
  ],
  "base_directory": "./downloads",
  "removed_directory": "./removed",
  "parent_uuid": "607c110c-48e1-4248-bf45-0eb0dfd06fb9",
  "parent_password": "juicetracker",
  "parent_key": "mdbzIcGzl9HcgB1KkbxGSVxaw2f2Ao1v",
  "max_chunks": 1024,
  "max_files": 128,
  "verify_retries": 3,
  "move_removed_files": true
}
```

### **Key Settings**

- **`exclude`**  
  List of folders you **don’t** want to download.  
  *To download everything, set this to an empty list:*
  ```json
  "exclude": []
  ```

- **`base_directory`**  
  Where downloaded files will be saved.

- **`removed_directory`**  
  Where removed files will be moved.

#### **Windows Users:**
- Use **double backslashes** in folder paths.  
  Example:  
  ```json
  "base_directory": "M:\\Music\\Juice WRLD"
  ```

#### **Mac/Linux Users:**
- Use **forward slashes**.  
  Example:  
  ```json
  "base_directory": "/Users/james/Music/Juice WRLD"
  ```

---

## 🏃‍♂️ Running the Program Again

- After editing `config.json`, just **double-click** the program again (or run it from the terminal).
- It will start downloading files based on your settings.

---

## 📝 Tips

- If you want to **download everything**, make sure:
  ```json
  "exclude": []
  ```
- If you want to **skip certain folders**, add them to the `exclude` list.

## 🐢 If Downloading Lags Your Computer

If running the program makes your computer slow or laggy, you can **lower the numbers** for `max_chunks` and `max_files` in your `config.json` file.

- **`max_chunks`** controls how many parts of files are downloaded at the same time.
- **`max_files`** controls how many files are downloaded at once.

**Try lowering these numbers** if you notice lag. For example:

```json
"max_chunks": 256,
"max_files": 16
```

Start with lower values and increase them if your computer can handle it.

---

## ❓ Need Help?

- If you get stuck, check the [Issues](https://github.com/kelllllllllllllllll/juice-filen/issues) page or dm me on discord `indolin` for help!

---

**Happy downloading!** 🎶
