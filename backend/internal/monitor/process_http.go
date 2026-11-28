package monitor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"time"
)

func (c *Collector) processListHTTP(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	sortKey := query.Get("sort")
	if sortKey == "" {
		sortKey = "cpu"
	}
	if !validProcessSort(sortKey) {
		writeError(w, http.StatusBadRequest, "invalid_sort", "排序方式无效")
		return
	}
	order := query.Get("order")
	switch order {
	case "":
		order = defaultProcessOrder(sortKey)
	case "asc", "desc":
	default:
		writeError(w, http.StatusBadRequest, "invalid_order", "排序方向无效")
		return
	}

	list, err := c.listProcesses(r.Context())
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		writeError(w, http.StatusInternalServerError, "processes_unavailable", "无法读取进程列表")
		return
	}
	list.Processes = filterProcesses(list.Processes, query.Get("q"))
	sortProcesses(list.Processes, sortKey, order)
	list.Total = len(list.Processes)
	writeJSON(w, http.StatusOK, list)
}

func (c *Collector) processDetailHTTP(w http.ResponseWriter, r *http.Request) {
	pid, err := strconv.Atoi(r.PathValue("pid"))
	if err != nil || pid <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_pid", "进程参数无效")
		return
	}
	var startTicks *uint64
	if raw := r.URL.Query().Get("startTicks"); raw != "" {
		value, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_start_ticks", "进程启动参数无效")
			return
		}
		startTicks = &value
	}

	detail, err := c.describeProcess(r.Context(), pid, startTicks)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, detail)
	case errors.Is(err, errProcessNotFound):
		writeError(w, http.StatusNotFound, "process_not_found", "进程不存在")
	case errors.Is(err, errProcessChanged):
		writeError(w, http.StatusConflict, "process_changed", "进程已变化，请重新加载")
	case errors.Is(err, os.ErrPermission):
		writeError(w, http.StatusForbidden, "permission_denied", "权限不足，无法读取该进程")
	case errors.Is(err, context.Canceled):
		return
	default:
		writeError(w, http.StatusInternalServerError, "detail_unavailable", "无法读取进程详情")
	}
}

func processSignalHTTP(execute processSignalExecutor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeError(w, http.StatusUnsupportedMediaType, "invalid_content_type", "需要 application/json 请求")
			return
		}
		var operation processSignalOperation
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
		if decoder.Decode(&operation) != nil || decoder.Decode(new(any)) != io.EOF {
			writeError(w, http.StatusBadRequest, "invalid_request", "进程参数无效")
			return
		}
		if operation.PID <= 1 {
			writeError(w, http.StatusForbidden, "forbidden_pid", "不能向 PID 1 或无效进程发送信号")
			return
		}
		if _, err := parseSignalName(operation.Signal); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_signal", "不支持的信号")
			return
		}
		if operation.StartTicks == 0 {
			writeError(w, http.StatusBadRequest, "invalid_target", "进程参数无效")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		result := execute(ctx, operation)
		w.Header().Set("Cache-Control", "no-store")
		if result.Status == http.StatusNoContent {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(result.Status)
		_, _ = w.Write(result.Body)
	}
}
