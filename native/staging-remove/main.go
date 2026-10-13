package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type request struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Dev  string `json:"dev"`
	Ino  string `json:"ino"`
}

func remove(req request) error {
	if !filepath.IsLocal(req.Path) {
		return errors.New("staging removal requires a local relative path")
	}
	parts := strings.Split(filepath.Clean(req.Path), string(filepath.Separator))
	metadata := len(parts) == 1 && (parts[0] == ".cleanup-owner.json" || regexp.MustCompile(`^\.\.cleanup-owner\.json\.\d+\.[a-f0-9]{16}\.tmp$`).MatchString(parts[0]))
	operation := len(parts) == 2 && regexp.MustCompile(`^deploy-[a-zA-Z0-9]+$`).MatchString(parts[1])
	if !metadata && !operation {
		return errors.New("staging removal requires a target and deployment directory")
	}
	root, err := os.OpenRoot(req.Root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	dev, ino, err := identity(file)
	file.Close()
	if err != nil {
		return err
	}
	if dev != req.Dev || ino != req.Ino {
		return errors.New("staging root changed before removal")
	}
	if operation {
		return root.RemoveAll(req.Path)
	}
	err = root.Remove(req.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func main() {
	var req request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 1024*1024))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&req)
	if err == nil {
		err = remove(req)
	}
	if err != nil {
		json.NewEncoder(os.Stderr).Encode(map[string]any{"message": err.Error(), "retryable": retryable(err)})
		os.Exit(1)
	}
}
