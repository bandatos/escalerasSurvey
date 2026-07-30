<script setup>
import { ref, onMounted } from "vue";
import { storeToRefs } from "pinia";

import { useSurveyStore } from "@/stores/surveyStore";
import { useStationStore } from "@/stores/stationStore";
import { useSyncStore } from "@/stores/syncStore";
import { useImageStore } from "@/stores/imageStore";
import { useSnackbarStore } from "@/stores/snackbarStore";
import { useAuthStore } from "@/stores/authStore";
import { IndexedDBService } from "@/services/indexDB.js";
import { useRouter } from "vue-router";
import UploadImage from "../components/UploadImage.vue";
import Stats from "@/components/form/Stats.vue";
import StairForm from "@/components/form/StairForm.vue";
import AvatarStation from "@/components/select_station/AvatarStation.vue";

// Stores
const surveyStore = useSurveyStore();
const stationStore = useStationStore();
const syncStore = useSyncStore();
const imageStore = useImageStore();
const snackbarStore = useSnackbarStore();
const authStore = useAuthStore();
const router = useRouter();

const loading_station = ref(false);

// const emit = defineEmits(["save-complete", "back"]);
const emit = defineEmits(["save-complete"]);

// Actualizar estadísticas de sincronización al montar
onMounted(async () => {

  // Si no hay relevamiento activo (ej: recarga directa en /station/:id),
  // reconstruir el estado a partir del id de la URL.
  if (!surveyStore.isActive) {
    console.log("No hay relevamiento activo, reconstruyendo estado desde URL");
    // Asegurar que el catálogo esté cargado (rawStairs / fullStations)
    if (stationStore.fullStations.length === 0) {
      await stationStore.init();
    }

    const stationId = Number(router.currentRoute.value.params.station_id);
    const station = stationStore.fullStations.find((s) => s.id === stationId);

    if (!station) {
      snackbarStore.showError("No se encontró la estación");
      router.push({ name: "Home" });
      return;
    }

    stationStore.selectStation(station);
    surveyStore.startSurvey(station);
  }

    // Validar autenticación
  if (!authStore.isAuthenticated) {
    snackbarStore.showError("Debes autenticarte para realizar relevamientos");
    router.push({ name: "Home" });
    return;
  }
  
  await syncStore.updateSyncStats();
});

const { currentStairs } = storeToRefs(surveyStore);
const { selectedStation } = storeToRefs(stationStore);

// Estado local
const expandedPanels = ref([]);

const all_status = [
  { label: "Pendiente", icon: "circle", color: "grey", key: "pending" },
  { label: "Funciona", icon: "check_circle", color: "green", is_working: true },
  { label: "No funciona", icon: "cancel", color: "red" },
];

// Marcar escalera como completada
const markStairComplete = (stairIndex) => {
  // Cerrar panel actual y abrir siguiente (si existe)
  const currentIndex = expandedPanels.value.indexOf(stairIndex);
  if (currentIndex > -1) {
    expandedPanels.value.splice(currentIndex, 1);
  }

  // if (stairIndex < surveyStore.total_stairs - 1) {
  //   expandedPanels.value.push(stairIndex + 1);
  // }
};

function showWarning(message) {
  snackbarStore.showWarning(message);
}

// Guardar datos completos
const handleSave = async () => {
  try {
    // Validar que todas las escaleras estén completadas
    const allCompleted = currentStairs.value.every(
      (s) => s.status === "completed"
    );

    if (!allCompleted) {
      snackbarStore.showWarning(
        "Debes completar todas las escaleras antes de guardar"
      );
      return;
    }
    loading_station.value = true;
    // 1. Guardar registro de estación en IndexedDB
    const savedRecord = await surveyStore.completeSurvey();

    // 2. Guardar imágenes SOLO para escaleras que NO fueron sincronizadas
    for (
      let stairIndex = 0;
      stairIndex < surveyStore.total_stairs;
      stairIndex++
    ) {
      const stair = currentStairs.value[stairIndex];
      const photos = imageStore.getStairPhotos(stair.id); // ✅ Usar stair.id en lugar de índice

      // Guardar en IndexedDB si las imágenes NO están confirmadas en el backend
      // (reporte fallido, sin conexión, o subida de imágenes fallida) para reintentar.
      // Se usa stair.number como clave para que syncPendingStairs las encuentre.
      if (photos && photos.length > 0 && stair.images_synced !== true) {
        await IndexedDBService.saveStairImages(
          savedRecord.id,
          stair.number,
          photos
        );
        console.log(
          `📸 ${photos.length} imágenes guardadas localmente para escalera ${stair.number} (pendiente de sync)`
        );
      } else if (photos && photos.length > 0 && stair.images_synced === true) {
        console.log(
          `✅ Escalera ${stair.number} con imágenes ya sincronizadas - no guardadas en IndexedDB`
        );
      }
    }

    // 3. Limpiar el imageStore
    imageStore.clearSelection();

    // 4. Actualizar estadísticas de sincronización
    await syncStore.updateSyncStats();

    console.log("✅ Estación y todas las imágenes guardadas exitosamente");
    loading_station.value = false;
    snackbarStore.showSuccess("Relevamiento guardado exitosamente");
    router.push({ name: "Home" });
  } catch (error) {
    console.error("Error guardando:", error);
    snackbarStore.showError("Error al guardar los datos");
    loading_station.value = false;
  }
};

// Volver a selector
const handleBack = () => {
  if (
    confirm("¿Seguro que quieres salir? Se perderá el progreso no guardado")
  ) {
    surveyStore.cancelSurvey();
    router.push({ name: "Home" });
    // emit("back");
  }
};
</script>

<template>
  <v-row no-gutters class="fill-height">
    <v-col cols="12">
      <!-- Header con status -->
      <v-card class="rounded-0" variant="flat" color="grey-lighten-5">
        <v-card-text>
          <!-- Estación seleccionada -->
          <div class="d-flex align-center">
            <AvatarStation
              v-if="selectedStation"
              :station-data="selectedStation"
              class="mr-3"
            />
            <h2 class="text-subtitle-1 font-weight-bold">
              Estación {{ selectedStation?.name }}
            </h2>
            <v-btn
              icon="close"
              size="small"
              variant="text"
              @click="handleBack"
              class="ml-auto"
            ></v-btn>
          </div>
        </v-card-text>
      </v-card>

      <Stats :surveyStore="surveyStore" class="mb-2" />

      <v-divider></v-divider>
      <v-alert type="info" density="compact" class="mb-2">
        Completa la info en el orden en el que recorras la estación
      </v-alert>

      <!-- Expansion Panels de Escaleras -->
      <v-expansion-panels v-model="expandedPanels" multiple>
        <StairForm
          v-for="(stair, stair_index) in currentStairs"
          :key="stair.id"
          :stair="stair"
          :stair_index="stair_index"
          :all_status="all_status"
          @showWarning="showWarning"
          @markComplete="markStairComplete(stair_index)"
        />
      </v-expansion-panels>

      <!-- Botón guardar todo -->
      <v-card v-if="true" class="rounded-0" _variant="flat" _color="primary">
        <v-card-actions class="pa-4">
          <v-btn
            color="primary"
            size="large"
            block
            variant="elevated"
            :loading="loading_station"
            :disabled="surveyStore.completedStairs < surveyStore.total_stairs"
            @click="handleSave"
          >
            Guardar datos
            <v-icon end>save</v-icon>
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.gap-2 {
  gap: 8px;
}

label {
  font-weight: 500;
}
</style>
